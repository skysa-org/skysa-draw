import { emptyDrawing } from '@skysa/draw-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renameLayer } from '../../src/drawing/document/commands.js';
import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import {
	canvasToPng,
	EXPORT_MAX_SIDE,
	exportBlob,
	exportSize,
	renderSvg,
} from '../../src/drawing/export/render.js';

/**
 * The render behind export (docs/ARCHITECTURE.md §7, "Export") against a real
 * document and a stand-in canvas: jsdom has no 2D context and decodes no
 * pictures, so `getContext`, `toBlob` and `decode` are stubbed, the context
 * records what is drawn on it, and every `blob:` URL made is kept so the SVG
 * the render was given can be read back.
 *
 * What this cannot show is a real render: the pixels a browser draws, an
 * encoder's output, and whether a browser makes a canvas this large.
 */

const DRAWING_ID = '11111111-2222-4333-8444-555555555555';

const open = (text = emptyDrawing({ id: DRAWING_ID, title: 'Floor plan' })): EditorDocument => {
	const document = openDocument(text);
	if (document === undefined) throw new Error('a drawing opens');
	return document;
};

type Call = Readonly<{ name: string; args: readonly unknown[]; fillStyle: unknown }>;

let calls: Call[] = [];
let contextShown = true;
let decodes = true;
let blobs: Blob[] = [];
let revoked: string[] = [];
let encodings: { canvas: HTMLCanvasElement; type: string | undefined; quality: unknown }[] = [];
let encodes = true;

const fakeContext = () => {
	const state: { fillStyle: unknown } = { fillStyle: '#000000' };
	const record =
		(name: string) =>
		(...args: unknown[]): void => {
			calls.push({ name, args, fillStyle: state.fillStyle });
		};
	return Object.assign(state, { fillRect: record('fillRect'), drawImage: record('drawImage') });
};

beforeEach(() => {
	calls = [];
	contextShown = true;
	decodes = true;
	blobs = [];
	revoked = [];
	encodings = [];
	encodes = true;
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
		() => (contextShown ? fakeContext() : null) as never
	);
	const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob');
	toBlob.mockImplementation((callback, type, quality) => {
		const canvas = toBlob.mock.contexts.at(-1) as HTMLCanvasElement;
		encodings.push({ canvas, type, quality });
		const blob = encodes ? new Blob(['pixels'], { type: type ?? 'image/png' }) : null;
		setTimeout(() => callback(blob), 0);
	});
	vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
		blobs.push(blob as Blob);
		return `blob:render-${blobs.length}`;
	});
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
		revoked.push(url);
	});
	Object.defineProperty(HTMLImageElement.prototype, 'decode', {
		configurable: true,
		writable: true,
		value: () => (decodes ? Promise.resolve() : Promise.reject(new Error('not a picture'))),
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
});

const named = (name: string) => calls.filter((call) => call.name === name);

const BOX = { x: 0, y: 0, width: 1600, height: 1000 } as const;

describe('renderSvg', () => {
	it('resolves undefined where there is no 2D context, and asks for no picture', async () => {
		contextShown = false;
		await expect(renderSvg(emptyDrawing({ id: DRAWING_ID }), BOX, 100, 50)).resolves.toBe(
			undefined
		);
		expect(blobs).toEqual([]);
	});

	it('resolves undefined for a picture that will not decode, and lets its URL go', async () => {
		decodes = false;
		await expect(renderSvg(emptyDrawing({ id: DRAWING_ID }), BOX, 100, 50)).resolves.toBe(
			undefined
		);
		expect(revoked).toEqual(['blob:render-1']);
	});

	it('draws the picture over the whole of a canvas the size asked for', async () => {
		const canvas = await renderSvg(emptyDrawing({ id: DRAWING_ID }), BOX, 800, 500);
		expect(canvas?.width).toBe(800);
		expect(canvas?.height).toBe(500);
		const [draw] = named('drawImage');
		expect(draw?.args[0]).toBeInstanceOf(HTMLImageElement);
		expect((draw?.args[0] as HTMLImageElement).getAttribute('src')).toBe('blob:render-1');
		expect(draw?.args.slice(1)).toEqual([0, 0, 800, 500]);
		expect(revoked).toEqual(['blob:render-1']);
	});

	it('renders the SVG at the pixel size, with the box as its viewBox, as an SVG image', async () => {
		await renderSvg(
			emptyDrawing({ id: DRAWING_ID }),
			{ x: 10, y: 20, width: 300, height: 200 },
			600,
			400
		);
		const [svg] = blobs;
		expect(svg?.type).toBe('image/svg+xml');
		const text = await svg?.text();
		expect(text).toMatch(/<svg [^>]*viewBox="10 20 300 200" width="600" height="400">/);
		// Each said once: the drawing's own are replaced, not repeated.
		expect(text?.match(/ width="/g)).toHaveLength(1);
		expect(text?.match(/ viewBox="/g)).toHaveLength(1);
		expect(text).toContain(`draw:id="${DRAWING_ID}"`);
		expect(text).toContain('<g id="layer-1" draw:kind="vector"/>');
	});

	it('gives a file with no size of its own one, keeping its prolog and its prefix', async () => {
		const inkscape = [
			'<?xml version="1.0"?>',
			'<!-- made elsewhere -->',
			'<svg:svg xmlns:svg="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"><svg:rect width="10" height="10"/></svg:svg>',
		].join('\n');
		await renderSvg(inkscape, BOX, 160, 100);
		const text = await blobs[0]?.text();
		expect(text).toBe(
			[
				'<?xml version="1.0"?>',
				'<!-- made elsewhere -->',
				'<svg:svg xmlns:svg="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 1600 1000" width="160" height="100"><svg:rect width="10" height="10"/></svg:svg>',
			].join('\n')
		);
	});
});

describe('exportSize', () => {
	it('is the canvas at the scale, rounded', () => {
		expect(exportSize({ width: 1600, height: 1000 }, 2)).toEqual({
			width: 3200,
			height: 2000,
			capped: false,
		});
		expect(exportSize({ width: 333, height: 101 }, 0.5)).toEqual({
			width: 167,
			height: 51,
			capped: false,
		});
	});

	it('keeps the longer side to the most a canvas has, and says so', () => {
		expect(EXPORT_MAX_SIDE).toBe(16_384);
		expect(exportSize({ width: 1600, height: 1000 }, 16)).toEqual({
			width: 16_384,
			height: 10_240,
			capped: true,
		});
	});

	it('is never less than a pixel', () => {
		expect(exportSize({ width: 1, height: 1000 }, 0.25)).toEqual({
			width: 1,
			height: 250,
			capped: false,
		});
	});
});

describe('exportBlob', () => {
	it('is the drawing’s own text for SVG, rendered nothing', async () => {
		const document = open();
		const blob = await exportBlob(document, 'svg', 1);
		expect(blob?.type).toBe('image/svg+xml');
		await expect(blob?.text()).resolves.toBe(document.text());
		expect(encodings).toEqual([]);
	});

	it('is the text as edited, for SVG', async () => {
		const document = open();
		document.execute(renameLayer('layer-1', 'Walls'));
		const blob = await exportBlob(document, 'svg', 1);
		const text = await blob?.text();
		expect(text).toBe(document.text());
		expect(text).toContain('draw:name="Walls"');
	});

	it('asks for twice the pixels at a scale of 2, as a PNG', async () => {
		const blob = await exportBlob(open(), 'png', 2);
		expect(blob?.type).toBe('image/png');
		expect(encodings).toHaveLength(1);
		const [encoding] = encodings;
		expect(encoding?.canvas.width).toBe(3200);
		expect(encoding?.canvas.height).toBe(2000);
		expect(encoding?.type).toBe('image/png');
		expect(encoding?.quality).toBeUndefined();
		expect(named('drawImage')[0]?.args.slice(1)).toEqual([0, 0, 3200, 2000]);
		expect(await blobs[0]?.text()).toMatch(
			/viewBox="0 0 1600 1000" width="3200" height="2000"/
		);
		// A PNG keeps its transparency: nothing is painted behind it.
		expect(named('fillRect')).toEqual([]);
	});

	it('fills a JPEG’s background white before the drawing goes on it', async () => {
		const blob = await exportBlob(open(), 'jpeg', 1);
		expect(blob?.type).toBe('image/jpeg');
		expect(calls.map((call) => call.name)).toEqual(['fillRect', 'drawImage']);
		expect(named('fillRect')[0]).toEqual({
			name: 'fillRect',
			args: [0, 0, 1600, 1000],
			fillStyle: '#ffffff',
		});
		expect(encodings[0]?.type).toBe('image/jpeg');
		expect(encodings[0]?.quality).toBe(0.92);
	});

	it('fills the background chosen, and asks WebP for the same quality', async () => {
		await exportBlob(open(), 'webp', 1, '#123456');
		expect(named('fillRect')[0]?.fillStyle).toBe('#123456');
		expect(encodings[0]?.type).toBe('image/webp');
		expect(encodings[0]?.quality).toBe(0.92);
	});

	it('exports the canvas as the viewBox now says, after a crop', async () => {
		const document = open();
		document.root.setAttribute('viewBox', '100 50 400 300');
		await exportBlob(document, 'png', 1);
		expect(encodings[0]?.canvas.width).toBe(400);
		expect(encodings[0]?.canvas.height).toBe(300);
	});

	it('waits for work a save would wait for before it reads the text', async () => {
		const document = open();
		const order: string[] = [];
		document.pending(
			new Promise<void>((resolve) =>
				setTimeout(() => {
					order.push('encoded');
					resolve();
				}, 5)
			)
		);
		await exportBlob(document, 'svg', 1).then(() => order.push('exported'));
		expect(order).toEqual(['encoded', 'exported']);
	});

	it('is undefined where the browser cannot render or encode it', async () => {
		contextShown = false;
		await expect(exportBlob(open(), 'png', 1)).resolves.toBeUndefined();
		contextShown = true;
		encodes = false;
		await expect(exportBlob(open(), 'png', 1)).resolves.toBeUndefined();
		await expect(exportBlob(open(), 'png', 0)).resolves.toBeUndefined();
	});
});

describe('canvasToPng', () => {
	it('is the canvas as a PNG data URL', async () => {
		const canvas = document.createElement('canvas');
		const url = await canvasToPng(canvas);
		expect(url).toBe(`data:image/png;base64,${btoa('pixels')}`);
		expect(encodings[0]?.type).toBe('image/png');
	});

	it('falls back to toDataURL where toBlob gives nothing', async () => {
		encodes = false;
		vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
			'data:image/png;base64,ZmFsbGJhY2s='
		);
		await expect(canvasToPng(document.createElement('canvas'))).resolves.toBe(
			'data:image/png;base64,ZmFsbGJhY2s='
		);
	});
});
