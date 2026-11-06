import { DRAWING_NAMESPACE, emptyDrawing, SVG_NAMESPACE } from '@skysa/draw-core';
import { describe, expect, it } from 'vitest';

import {
	type CanvasTurn,
	resizeCanvas,
	resizeImage,
	revealAll,
	rotateCanvas,
	trimCanvas,
	turnCanvas,
} from '../../src/drawing/document/canvasOps.js';
import type { Composite, Resampler } from '../../src/drawing/document/canvasPixels.js';
import { isPlainTransform, retransformed } from '../../src/drawing/document/canvasTransform.js';
import { renameLayer } from '../../src/drawing/document/commands.js';
import { canvasBoxOf } from '../../src/drawing/document/crop.js';
import type { Command, EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import type { LayerExtent } from '../../src/drawing/tools/common/align.js';
import {
	apply,
	type Box,
	IDENTITY,
	invert,
	type Mat,
	multiply,
	parseTransform,
	rotate,
	translate,
} from '../../src/drawing/tools/vector/geometry.js';

/**
 * The Image operations (`document/canvasOps.ts`): the fixed turns and flips,
 * Arbitrary…, Canvas Size, Image Size with and without resampling, Trim and
 * Reveal All. Each over a real document, each one step that undoes to the
 * very bytes, and each checked by where things are drawn afterward, every
 * layer and every clip, rather than by the text alone. jsdom has no canvas,
 * so the pictures made again and the drawing rendered are answered here.
 */

const XLINK = 'http://www.w3.org/1999/xlink';

const PICTURE = 'data:image/png;base64,AAAA';

const svg = (attributes: string, body: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" xmlns:xlink="${XLINK}" draw:id="d1" ${attributes}>
  <title>Image</title>
${body}
</svg>
`;

/** A raster layer, a moved vector layer clipped to by the one above it, a loose rect and an empty layer. */
const LAYERED = svg(
	'viewBox="0 0 1600 1000" width="1600" height="1000"',
	`  <defs>
    <mask id="clip-layer-3" style="mask-type:alpha"><use href="#layer-2"/></mask>
  </defs>
  <g id="layer-1" draw:kind="raster"><image href="${PICTURE}" x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/></g>
  <g id="layer-2" draw:kind="vector" transform="translate(10 20)"><rect x="100" y="100" width="200" height="100"/></g>
  <g id="layer-3" draw:kind="vector" transform="translate(-30 5)" mask="url(#clip-layer-3)"><path d="M0 0 L50 50"/></g>
  <rect id="layer-4" x="5" y="5" width="10" height="10"/>
  <g id="layer-5" draw:kind="vector"/>`
);

const open = (text: string): EditorDocument => {
	const document = openDocument(text);
	if (document === undefined) throw new Error('the drawing opens');
	return document;
};

const byId = (document: EditorDocument, id: string): Element => {
	const found = document.root.querySelector(`[id="${id}"]`);
	if (found === null) throw new Error(`no element ${id}`);
	return found;
};

/** Where an element's user units are in the root's, from the transforms written down to it. */
const placeIn = (root: Element, element: Element | null): Mat =>
	element === null || element === root
		? IDENTITY
		: multiply(
				placeIn(root, element.parentElement),
				parseTransform(element.getAttribute('transform'))
			);

const placeOfId = (document: EditorDocument, id: string): Mat =>
	placeIn(document.root, byId(document, id));

/**
 * Where the clip of the layer `id` draws the layer it names: the clipped
 * layer's user units, then the `<use>`'s `transform` and its `x` and `y`,
 * then the named layer's own `transform`, as SVG draws a `<use>`.
 */
const clipPlace = (document: EditorDocument, id: string): Mat => {
	const layer = byId(document, id);
	const maskId = /#([^)]+)\)/.exec(layer.getAttribute('mask') ?? '')?.[1] ?? '';
	const use = byId(document, maskId).querySelector('use');
	if (use === null) throw new Error('the clip has a use');
	return cloneDrawnAt(document, placeIn(document.root, layer), use);
};

const cloneDrawnAt = (document: EditorDocument, space: Mat, use: Element): Mat => {
	const link = use.getAttribute('href') ?? use.getAttributeNS(XLINK, 'href') ?? '';
	const named = byId(document, link.slice(1));
	const at = translate(Number(use.getAttribute('x') ?? 0), Number(use.getAttribute('y') ?? 0));
	return multiply(
		multiply(multiply(space, parseTransform(use.getAttribute('transform'))), at),
		parseTransform(named.getAttribute('transform'))
	);
};

const expectMatrix = (actual: Mat, expected: Mat): void => {
	actual.forEach((value, index) => {
		expect(value).toBeCloseTo(expected[index] ?? Number.NaN, 4);
	});
};

/**
 * The command run on a document that has a step behind it already, so its
 * undo is measured against serialized text and not the opened text the
 * document gives back at its origin; and redo, which must make the same.
 */
const undoesExactly = (document: EditorDocument, command: (live: SVGSVGElement) => Command) => {
	document.execute(renameLayer('layer-1', 'Before'));
	const before = document.text();
	document.execute(command(document.root));
	const after = document.text();
	expect(after).not.toBe(before);
	document.undo();
	expect(document.text()).toBe(before);
	document.redo();
	expect(document.text()).toBe(after);
	document.undo();
	document.undo();
	expect(document.text()).toBe(LAYERED);
};

describe('the fixed turns and flips', () => {
	it('turns a quarter clockwise: the canvas swaps its sides, every layer turns with it', () => {
		const document = open(LAYERED);
		const before = Object.fromEntries(
			['layer-1', 'layer-2', 'layer-3', 'layer-4'].map((id) => [id, placeOfId(document, id)])
		);
		document.execute(turnCanvas(document.root, document.size, 'rotate90cw'));
		const turn: Mat = [0, 1, -1, 0, 1000, 0];
		expect(document.root.getAttribute('viewBox')).toBe('0 0 1000 1600');
		expect(document.root.getAttribute('width')).toBe('1000');
		expect(document.root.getAttribute('height')).toBe('1600');
		expect(document.snapshot().size).toEqual({ width: 1000, height: 1600 });
		expect(byId(document, 'layer-1').getAttribute('transform')).toBe('matrix(0 1 -1 0 1000 0)');
		expect(byId(document, 'layer-2').getAttribute('transform')).toBe('matrix(0 1 -1 0 980 10)');
		Object.entries(before).forEach(([id, place]) => {
			expectMatrix(placeOfId(document, id), multiply(turn, place));
		});
		// The clip shows the layer below where that layer is now drawn, its use
		// the inverse of the clipped layer's new transform (`clip.ts`).
		expectMatrix(clipPlace(document, 'layer-3'), placeOfId(document, 'layer-2'));
		// The raster layer's picture is untouched: nothing is resampled.
		expect(byId(document, 'layer-1').querySelector('image')?.getAttribute('href')).toBe(
			PICTURE
		);
	});

	it('leaves a layer with nothing in it as it is, so what is drawn on it later is upright', () => {
		const document = open(LAYERED);
		document.execute(turnCanvas(document.root, document.size, 'flipHorizontal'));
		expect(byId(document, 'layer-5').hasAttribute('transform')).toBe(false);
		const empty = open(emptyDrawing({ id: 'd2' }));
		const flip = turnCanvas(empty.root, empty.size, 'flipVertical');
		empty.execute(flip);
		expect(flip.bytes).toBe(0);
		expect(empty.snapshot().dirty).toBe(false);
		empty.execute(turnCanvas(empty.root, empty.size, 'rotate90ccw'));
		expect(empty.root.getAttribute('viewBox')).toBe('0 0 1000 1600');
		expect(empty.root.querySelector('g')?.hasAttribute('transform')).toBe(false);
	});

	it.each<[CanvasTurn, string, string]>([
		['rotate180', 'image.undo.rotate', '10 20 300 200'],
		['rotate90cw', 'image.undo.rotate', '10 20 200 300'],
		['rotate90ccw', 'image.undo.rotate', '10 20 200 300'],
		['flipHorizontal', 'image.undo.flip', '10 20 300 200'],
		['flipVertical', 'image.undo.flip', '10 20 300 200'],
	])('%s carries the canvas onto the new one, its corner kept', (turn, label, viewBox) => {
		const text = svg(
			'viewBox="10 20 300 200"',
			'  <g id="layer-1" draw:kind="vector"><rect x="10" y="20" width="300" height="200"/></g>'
		);
		const document = open(text);
		const command = turnCanvas(document.root, document.size, turn);
		expect(command.label).toBe(label);
		document.execute(command);
		expect(document.root.getAttribute('viewBox')).toBe(viewBox);
		const box = canvasBoxOf(document.root, document.size);
		const place = placeOfId(document, 'layer-1');
		const corners = [
			[10, 20],
			[310, 20],
			[10, 220],
			[310, 220],
		].map(([x = 0, y = 0]) => apply(place, { x, y }));
		const expected = [
			{ x: box.x, y: box.y },
			{ x: box.x + box.width, y: box.y },
			{ x: box.x, y: box.y + box.height },
			{ x: box.x + box.width, y: box.y + box.height },
		];
		const key = ({ x, y }: { x: number; y: number }) => `${Math.round(x)},${Math.round(y)}`;
		expect(new Set(corners.map(key))).toEqual(new Set(expected.map(key)));
		document.undo();
		expect(document.text()).toBe(text);
	});

	it('undoes to the bytes and redoes the same', () => {
		undoesExactly(open(LAYERED), (live) =>
			turnCanvas(live, { width: 1600, height: 1000 }, 'rotate90ccw')
		);
	});

	it('turns a group whole and leaves the layers in it as they are, their clips with them', () => {
		const text = svg(
			'viewBox="0 0 400 300"',
			`  <defs><mask id="clip-layer-3" style="mask-type:alpha"><use href="#layer-2"/></mask></defs>
  <g id="layer-1" draw:kind="group" transform="rotate(30 50 50)">
    <g id="layer-2" draw:kind="vector" transform="translate(5 5)"><rect width="20" height="20"/></g>
    <g id="layer-3" draw:kind="vector" mask="url(#clip-layer-3)"><rect width="40" height="40"/></g>
  </g>`
		);
		const document = open(text);
		const inner = byId(document, 'layer-2').getAttribute('transform');
		const before = placeOfId(document, 'layer-2');
		const clip = clipPlace(document, 'layer-3');
		document.execute(turnCanvas(document.root, document.size, 'rotate180'));
		const turn: Mat = [-1, 0, 0, -1, 400, 300];
		expect(byId(document, 'layer-2').getAttribute('transform')).toBe(inner);
		expect(byId(document, 'clip-layer-3').querySelector('use')?.hasAttribute('transform')).toBe(
			false
		);
		expectMatrix(placeOfId(document, 'layer-2'), multiply(turn, before));
		expectMatrix(clipPlace(document, 'layer-3'), multiply(turn, clip));
	});

	it('keeps a raster layer with no picture where it is, inside a group that turns too', () => {
		const text = svg(
			'viewBox="0 0 400 300"',
			`  <g id="layer-1" draw:kind="raster"/>
  <g id="layer-2" draw:kind="group" transform="translate(7 3)">
    <g id="layer-3" draw:kind="raster"/>
    <g id="layer-4" draw:kind="vector"><rect width="20" height="20"/></g>
  </g>`
		);
		const document = open(text);
		const kept = placeOfId(document, 'layer-3');
		document.execute(rotateCanvas(document.root, document.size, 30));
		expect(byId(document, 'layer-1').hasAttribute('transform')).toBe(false);
		expectMatrix(placeOfId(document, 'layer-3'), kept);
		expect(byId(document, 'layer-2').getAttribute('transform')).toMatch(/^matrix\(/);
	});

	it('moves a clone of a layer with the drawing, its x and y counted', () => {
		const text = svg(
			'viewBox="0 0 400 300"',
			`  <g id="layer-1" draw:kind="vector" transform="translate(30 40)"><rect width="20" height="20"/></g>
  <g id="layer-2" draw:kind="vector" transform="scale(2)"><use xlink:href="#layer-1" x="15" y="-5" transform="rotate(10)"/></g>
  <use id="layer-3" href="#layer-1" x="3" y="4"/>`
		);
		const document = open(text);
		const use = byId(document, 'layer-2').querySelector('use');
		if (use === null) throw new Error('the clone is there');
		const clone = cloneDrawnAt(document, placeOfId(document, 'layer-2'), use);
		const loose = cloneDrawnAt(document, IDENTITY, byId(document, 'layer-3'));
		document.execute(turnCanvas(document.root, document.size, 'rotate90cw'));
		const turn: Mat = [0, 1, -1, 0, 300, 0];
		expectMatrix(
			cloneDrawnAt(document, placeOfId(document, 'layer-2'), use),
			multiply(turn, clone)
		);
		expectMatrix(
			cloneDrawnAt(document, IDENTITY, byId(document, 'layer-3')),
			multiply(turn, loose)
		);
	});

	it('leaves the clip of a raster layer with no picture following the layer below', () => {
		const text = svg(
			'viewBox="0 0 400 300"',
			`  <defs><mask id="clip-layer-2" style="mask-type:alpha"><use href="#layer-1"/></mask></defs>
  <g id="layer-1" draw:kind="vector"><rect width="20" height="20"/></g>
  <g id="layer-2" draw:kind="raster" mask="url(#clip-layer-2)"/>`
		);
		const document = open(text);
		document.execute(turnCanvas(document.root, document.size, 'flipHorizontal'));
		expect(byId(document, 'clip-layer-2').querySelector('use')?.hasAttribute('transform')).toBe(
			false
		);
		expectMatrix(clipPlace(document, 'layer-2'), placeOfId(document, 'layer-1'));
	});

	it('moves a use inside a definition a moving layer reaches through another', () => {
		const text = svg(
			'viewBox="0 0 400 300"',
			`  <defs>
    <pattern id="tile" width="10" height="10" patternUnits="userSpaceOnUse"><use href="#layer-1"/></pattern>
    <pattern id="tiled" href="#tile"/>
    <pattern id="unused"><use href="#layer-1"/></pattern>
  </defs>
  <g id="layer-1" draw:kind="vector"><rect width="4" height="4"/></g>
  <g id="layer-2" draw:kind="vector"><rect width="40" height="40" fill="url(#tiled)"/></g>`
		);
		const document = open(text);
		document.execute(turnCanvas(document.root, document.size, 'rotate180'));
		expect(byId(document, 'tile').querySelector('use')?.getAttribute('transform')).toBe(
			'matrix(-1 0 0 -1 400 300)'
		);
		expect(byId(document, 'unused').querySelector('use')?.hasAttribute('transform')).toBe(
			false
		);
	});

	it('keeps a transform it cannot read as written, the turn in front of it', () => {
		const text = svg(
			'viewBox="0 0 400 300"',
			'  <g id="layer-1" draw:kind="vector" transform="translate(10px, 5px)"><rect width="20" height="20"/></g>'
		);
		const document = open(text);
		document.execute(turnCanvas(document.root, document.size, 'flipVertical'));
		expect(byId(document, 'layer-1').getAttribute('transform')).toBe(
			'matrix(1 0 0 -1 0 300) translate(10px, 5px)'
		);
	});
});

describe('a transform list', () => {
	it.each([
		['translate(10 20)', true],
		['translate(10,20) rotate(30 5 5), scale(2)', true],
		['matrix(1 0 0 1 2 3)', true],
		['matrix(1 0 0 1 2)', false],
		['rotate(30deg)', false],
		['translate(10px)', false],
		['perspective(3)', false],
		['', true],
	])('%s is plain: %s', (text, plain) => {
		expect(isPlainTransform(text)).toBe(plain);
	});

	it('folds what is plain into one matrix, and keeps what is not between the two', () => {
		expect(retransformed('translate(10 20)', [0, 1, -1, 0, 0, 0], IDENTITY)).toBe(
			'matrix(0 1 -1 0 -20 10)'
		);
		expect(retransformed(null, translate(1, 2), translate(-1, -2))).toBe('');
		expect(retransformed('rotate(1turn)', translate(1, 2), translate(3, 4))).toBe(
			'matrix(1 0 0 1 1 2) rotate(1turn) matrix(1 0 0 1 3 4)'
		);
	});
});

describe('Arbitrary', () => {
	it('is the fixed turn for a quarter, either way, and nothing for none', () => {
		const one = open(LAYERED);
		one.execute(rotateCanvas(one.root, one.size, 90));
		const other = open(LAYERED);
		other.execute(turnCanvas(other.root, other.size, 'rotate90cw'));
		expect(one.text()).toBe(other.text());
		const back = open(LAYERED);
		back.execute(rotateCanvas(back.root, back.size, -90));
		const ccw = open(LAYERED);
		ccw.execute(turnCanvas(ccw.root, ccw.size, 'rotate90ccw'));
		expect(back.text()).toBe(ccw.text());
		[0, 360, -720, Number.NaN].forEach((degrees) => {
			const document = open(LAYERED);
			document.execute(rotateCanvas(document.root, document.size, degrees));
			expect(document.snapshot().dirty).toBe(false);
		});
	});

	it('turns about the center and grows the canvas to the box around it, in whole units', () => {
		const document = open(LAYERED);
		const before = placeOfId(document, 'layer-2');
		const command = rotateCanvas(document.root, document.size, 30);
		expect(command.label).toBe('image.undo.rotate');
		document.execute(command);
		// 1600 cos 30° + 1000 sin 30° = 1885.6, and 1600 sin 30° + 1000 cos 30° = 1666.03.
		expect(document.root.getAttribute('viewBox')).toBe('0 0 1886 1667');
		expect(document.root.getAttribute('width')).toBe('1886');
		const turn = multiply(translate(943 - 800, 833.5 - 500), rotate(30, { x: 800, y: 500 }));
		expectMatrix(placeOfId(document, 'layer-2'), multiply(turn, before));
		expectMatrix(clipPlace(document, 'layer-3'), placeOfId(document, 'layer-2'));
		// The old canvas's corners land inside the new one, its center at the new center.
		const center = apply(turn, { x: 800, y: 500 });
		expect(center.x).toBeCloseTo(943, 6);
		expect(center.y).toBeCloseTo(833.5, 6);
	});

	it('undoes to the bytes', () => {
		undoesExactly(open(LAYERED), (live) =>
			rotateCanvas(live, { width: 1600, height: 1000 }, -12.5)
		);
	});
});

describe('Canvas Size', () => {
	it.each([
		['topLeft', '0 0 2000 1200'],
		['top', '-200 0 2000 1200'],
		['topRight', '-400 0 2000 1200'],
		['left', '0 -100 2000 1200'],
		['center', '-200 -100 2000 1200'],
		['right', '-400 -100 2000 1200'],
		['bottomLeft', '0 -200 2000 1200'],
		['bottom', '-200 -200 2000 1200'],
		['bottomRight', '-400 -200 2000 1200'],
	] as const)('grows from %s, nothing drawn moving', (anchor, viewBox) => {
		const document = open(LAYERED);
		const before = ['layer-1', 'layer-2', 'layer-4'].map((id) => placeOfId(document, id));
		const command = resizeCanvas(
			document.root,
			document.size,
			{ width: 2000, height: 1200 },
			anchor
		);
		expect(command.label).toBe('image.undo.canvasSize');
		document.execute(command);
		expect(document.root.getAttribute('viewBox')).toBe(viewBox);
		expect(document.root.getAttribute('width')).toBe('2000');
		expect(document.root.getAttribute('height')).toBe('1200');
		['layer-1', 'layer-2', 'layer-4'].forEach((id, index) => {
			expect(placeOfId(document, id)).toEqual(before[index]);
		});
	});

	it('splits an odd difference with the odd unit to the right and the bottom, growing or shrinking', () => {
		const grown = open(LAYERED);
		grown.execute(
			resizeCanvas(grown.root, grown.size, { width: 1603, height: 1001 }, 'center')
		);
		expect(grown.root.getAttribute('viewBox')).toBe('-1 0 1603 1001');
		const shrunk = open(LAYERED);
		shrunk.execute(
			resizeCanvas(shrunk.root, shrunk.size, { width: 1597, height: 999 }, 'center')
		);
		expect(shrunk.root.getAttribute('viewBox')).toBe('1 0 1597 999');
	});

	it('rounds to whole units, and does nothing for the same size or for none', () => {
		[
			{ width: 1600.4, height: 999.6 },
			{ width: 0, height: 100 },
			{ width: -5, height: 100 },
			{ width: Number.NaN, height: 100 },
		].forEach((size) => {
			const document = open(LAYERED);
			document.execute(resizeCanvas(document.root, document.size, size, 'center'));
			expect(document.snapshot().dirty).toBe(false);
		});
		const document = open(LAYERED);
		document.execute(
			resizeCanvas(document.root, document.size, { width: 800.6, height: 499.4 }, 'topLeft')
		);
		expect(document.root.getAttribute('viewBox')).toBe('0 0 801 499');
	});

	it('says the size in the file’s own unit', () => {
		const text = svg(
			'viewBox="0 0 210 297" width="210mm" height="297mm"',
			'  <g id="layer-1" draw:kind="vector"/>'
		);
		const document = open(text);
		document.execute(
			resizeCanvas(document.root, document.size, { width: 420, height: 297 }, 'left')
		);
		expect(document.root.getAttribute('viewBox')).toBe('0 0 420 297');
		expect(document.root.getAttribute('width')).toBe('420mm');
		expect(document.root.getAttribute('height')).toBe('297mm');
	});

	it('undoes to the bytes', () => {
		undoesExactly(open(LAYERED), (live) =>
			resizeCanvas(
				live,
				{ width: 1600, height: 1000 },
				{ width: 1201, height: 777 },
				'bottomRight'
			)
		);
	});
});

type Made = { href: string; width: number; height: number };

/** A resampler that says each picture is `natural` pixels and records what it is asked to make. */
const fakeResampler =
	(natural: Readonly<{ width: number; height: number }>, made: Made[] = []): Resampler =>
	(href) =>
		Promise.resolve({
			...natural,
			drawn: (size) => {
				made.push({ href, ...size });
				return Promise.resolve(`data:image/png;base64,${size.width}x${size.height}`);
			},
		});

const imageOfLayer = (document: EditorDocument, id: string): Element => {
	const image = byId(document, id).querySelector('image');
	if (image === null) throw new Error(`no picture on ${id}`);
	return image;
};

/** The corners of a picture's box, in the root's user units. */
const pictureCorners = (
	document: EditorDocument,
	id: string
): readonly { x: number; y: number }[] => {
	const image = imageOfLayer(document, id);
	const place = placeIn(document.root, image);
	const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((name) =>
		Number(image.getAttribute(name) ?? 0)
	) as [number, number, number, number];
	return [
		{ x, y },
		{ x: x + width, y: y + height },
	].map((corner) => apply(place, corner));
};

describe('Image Size', () => {
	it('scales everything drawn and the canvas without resampling', async () => {
		const document = open(LAYERED);
		const before = ['layer-1', 'layer-2', 'layer-4'].map((id) => placeOfId(document, id));
		expect(await resizeImage(document, { width: 800, height: 500, resample: false })).toBe(
			'done'
		);
		const scale: Mat = [0.5, 0, 0, 0.5, 0, 0];
		expect(document.root.getAttribute('viewBox')).toBe('0 0 800 500');
		expect(document.root.getAttribute('width')).toBe('800');
		expect(byId(document, 'layer-1').getAttribute('transform')).toBe('matrix(0.5 0 0 0.5 0 0)');
		expect(imageOfLayer(document, 'layer-1').getAttribute('href')).toBe(PICTURE);
		['layer-1', 'layer-2', 'layer-4'].forEach((id, index) => {
			expectMatrix(placeOfId(document, id), multiply(scale, before[index] ?? IDENTITY));
		});
		expectMatrix(clipPlace(document, 'layer-3'), placeOfId(document, 'layer-2'));
		document.undo();
		expect(document.text()).toBe(LAYERED);
	});

	it('scales about the canvas’s corner, so nothing shifts on it', async () => {
		const text = svg(
			'viewBox="100 50 400 300"',
			'  <g id="layer-1" draw:kind="vector"><rect x="100" y="50" width="10" height="10"/></g>'
		);
		const document = open(text);
		await resizeImage(document, { width: 800, height: 150, resample: false });
		expect(document.root.getAttribute('viewBox')).toBe('100 50 800 150');
		const place = placeOfId(document, 'layer-1');
		expect(apply(place, { x: 100, y: 50 })).toEqual({ x: 100, y: 50 });
		expect(apply(place, { x: 500, y: 350 })).toEqual({ x: 900, y: 200 });
	});

	it('makes each raster picture again, as many pixels to a unit as it had, its box grown by as much', async () => {
		const text = svg(
			'viewBox="0 0 1600 1000" width="1600" height="1000"',
			`  <g id="layer-1" draw:kind="raster"><image href="${PICTURE}" x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/></g>
  <g id="layer-2" draw:kind="group" transform="scale(2)">
    <g id="layer-3" draw:kind="raster" transform="translate(4 6)"><image xlink:href="${PICTURE}" x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/></g>
  </g>`
		);
		const document = open(text);
		const corners = ['layer-1', 'layer-3'].map((id) => pictureCorners(document, id));
		const made: Made[] = [];
		const job = await resizeImage(
			document,
			{ width: 2400, height: 1500, resample: true },
			fakeResampler({ width: 1600, height: 1000 }, made)
		);
		expect(job).toBe('done');
		expect(made.map(({ width, height }) => [width, height])).toEqual([
			[2400, 1500],
			[2400, 1500],
		]);
		// At the root the layer needs no transform: its box is its pixels again.
		expect(byId(document, 'layer-1').hasAttribute('transform')).toBe(false);
		const image = imageOfLayer(document, 'layer-1');
		expect(['x', 'y', 'width', 'height'].map((name) => image.getAttribute(name))).toEqual([
			'0',
			'0',
			'2400',
			'1500',
		]);
		expect(image.getAttribute('href')).toBe('data:image/png;base64,2400x1500');
		expect(imageOfLayer(document, 'layer-3').hasAttributeNS(XLINK, 'href')).toBe(false);
		['layer-1', 'layer-3'].forEach((id, index) => {
			pictureCorners(document, id).forEach((corner, at) => {
				const old = corners[index]?.[at] ?? { x: Number.NaN, y: Number.NaN };
				expect(corner.x).toBeCloseTo(old.x * 1.5, 4);
				expect(corner.y).toBeCloseTo(old.y * 1.5, 4);
			});
		});
		document.undo();
		expect(document.text()).toBe(text);
	});

	it('stretches a turned picture along its own axes', async () => {
		const text = svg(
			'viewBox="0 0 400 300"',
			`  <g id="layer-1" draw:kind="raster" transform="matrix(0 1 -1 0 300 0)"><image href="${PICTURE}" width="300" height="400" preserveAspectRatio="none"/></g>`
		);
		const document = open(text);
		const made: Made[] = [];
		await resizeImage(
			document,
			{ width: 800, height: 300, resample: true },
			fakeResampler({ width: 300, height: 400 }, made)
		);
		// The picture's across is the drawing's down, which keeps its size.
		expect(made.map(({ width, height }) => [width, height])).toEqual([[300, 800]]);
	});

	it('scales, and does not make again, an SVG picture or one placed some other way', async () => {
		const text = svg(
			'viewBox="0 0 400 300"',
			`  <g id="layer-1" draw:kind="raster"><image href="data:image/svg+xml;base64,AAAA" width="400" height="300" preserveAspectRatio="none"/></g>
  <g id="layer-2" draw:kind="raster"><image href="${PICTURE}" width="400" height="300"/></g>`
		);
		const document = open(text);
		const made: Made[] = [];
		expect(
			await resizeImage(
				document,
				{ width: 800, height: 600, resample: true },
				fakeResampler({ width: 400, height: 300 }, made)
			)
		).toBe('done');
		expect(made).toEqual([]);
		expect(byId(document, 'layer-1').getAttribute('transform')).toBe('matrix(2 0 0 2 0 0)');
	});

	it('keeps a picture to a raster layer’s most pixels, or to what it had where it had more', async () => {
		const text = svg(
			'viewBox="0 0 3000 100"',
			`  <g id="layer-1" draw:kind="raster"><image href="${PICTURE}" width="3000" height="100" preserveAspectRatio="none"/></g>`
		);
		const document = open(text);
		const made: Made[] = [];
		await resizeImage(
			document,
			{ width: 6000, height: 200, resample: true },
			fakeResampler({ width: 3000, height: 100 }, made)
		);
		expect(made.map(({ width, height }) => [width, height])).toEqual([[4096, 137]]);
		const large = open(text);
		const none: Made[] = [];
		await resizeImage(
			large,
			{ width: 6000, height: 200, resample: true },
			fakeResampler({ width: 5000, height: 100 }, none)
		);
		expect(none).toEqual([]);
		expect(imageOfLayer(large, 'layer-1').getAttribute('href')).toBe(PICTURE);
	});

	it('changes nothing where a picture will not decode, or the drawing changed meanwhile', async () => {
		const failing = open(LAYERED);
		expect(
			await resizeImage(failing, { width: 800, height: 500, resample: true }, () =>
				Promise.reject(new Error('no'))
			)
		).toBe('unrenderable');
		expect(failing.snapshot().dirty).toBe(false);
		// jsdom decodes nothing, which the browser's resampler says the same way.
		const browser = open(LAYERED);
		expect(await resizeImage(browser, { width: 800, height: 500, resample: true })).toBe(
			'unrenderable'
		);
		const changing = open(LAYERED);
		const resampler: Resampler = (href) => {
			changing.execute(renameLayer('layer-2', 'Meanwhile'));
			return fakeResampler({ width: 1600, height: 1000 })(href);
		};
		expect(
			await resizeImage(changing, { width: 800, height: 500, resample: true }, resampler)
		).toBe('changed');
		expect(changing.root.getAttribute('viewBox')).toBe('0 0 1600 1000');
		changing.undo();
		expect(changing.text()).toBe(LAYERED);
	});

	it('is work a save waits for, and nothing at the size it is', async () => {
		const document = open(LAYERED);
		const job = resizeImage(
			document,
			{ width: 3200, height: 2000, resample: true },
			fakeResampler({ width: 1600, height: 1000 })
		);
		await document.settle();
		expect(document.root.getAttribute('viewBox')).toBe('0 0 3200 2000');
		expect(await job).toBe('done');
		expect(await resizeImage(document, { width: 3200.2, height: 2000, resample: true })).toBe(
			'nothing'
		);
	});
});

/** An extent that answers from a table, and records what it was asked. */
const extentFrom =
	(boxes: Readonly<Record<string, Box>>, asked: string[] = []): LayerExtent =>
	(id) => {
		asked.push(id);
		return Promise.resolve(boxes[id]);
	};

const TRIMMED = svg(
	'viewBox="0 0 1600 1000" width="1600" height="1000"',
	`  <g id="layer-1" draw:kind="vector"><rect width="10" height="10"/></g>
  <g id="layer-2" draw:kind="vector" display="none"><rect width="10" height="10"/></g>
  <g id="layer-3" draw:kind="group">
    <g id="layer-4" draw:kind="vector"><rect width="10" height="10"/></g>
  </g>`
);

const ALL_SIDES = { top: true, bottom: true, left: true, right: true };

describe('Trim', () => {
	it('cuts to what the shown layers paint, outward to whole units', async () => {
		const document = open(TRIMMED);
		const asked: string[] = [];
		const extent = extentFrom(
			{
				'layer-1': { x: 100.4, y: 50, width: 200, height: 100.2 },
				'layer-2': { x: 0, y: 0, width: 1600, height: 1000 },
				'layer-3': { x: 400, y: 300, width: 10.5, height: 10 },
			},
			asked
		);
		expect(await trimCanvas(document, 'transparent', ALL_SIDES, extent)).toBe('done');
		expect(asked).toEqual(['layer-1', 'layer-3']);
		expect(document.root.getAttribute('viewBox')).toBe('100 50 311 260');
		expect(document.root.getAttribute('width')).toBe('311');
		expect(document.snapshot().layers.length).toBe(4);
		document.undo();
		expect(document.text()).toBe(TRIMMED);
	});

	it('cuts only the sides asked, and never past the canvas', async () => {
		const document = open(TRIMMED);
		const extent = extentFrom({ 'layer-1': { x: -50, y: 100, width: 300, height: 2000 } });
		await trimCanvas(
			document,
			'transparent',
			{ ...ALL_SIDES, left: false, top: false },
			extent
		);
		expect(document.root.getAttribute('viewBox')).toBe('0 0 250 1000');
	});

	it('does nothing where nothing is painted, nothing would be cut, or no side may be', async () => {
		const cases: readonly [Record<string, Box>, typeof ALL_SIDES][] = [
			[{}, ALL_SIDES],
			[{ 'layer-1': { x: 1700, y: 0, width: 10, height: 10 } }, ALL_SIDES],
			[{ 'layer-1': { x: -10, y: -10, width: 2000, height: 2000 } }, ALL_SIDES],
			[
				{ 'layer-1': { x: 10, y: 10, width: 10, height: 10 } },
				{ top: false, bottom: false, left: false, right: false },
			],
		];
		await Promise.all(
			cases.map(async ([boxes, sides]) => {
				const document = open(TRIMMED);
				expect(await trimCanvas(document, 'transparent', sides, extentFrom(boxes))).toBe(
					'nothing'
				);
				expect(document.snapshot().dirty).toBe(false);
			})
		);
	});

	/** A rendered drawing of 16 × 10 pixels of `background`, with a block of red at 3, 2 to 5, 6. */
	const blockComposite =
		(background: readonly number[], asked: unknown[] = []): Composite =>
		(_document, box, width, height) => {
			asked.push({ box, width, height });
			const data = new Uint8ClampedArray(width * height * 4);
			Array.from({ length: width * height }, (_, index) => index).forEach((index) => {
				const x = index % width;
				const y = Math.floor(index / width);
				const inside = x >= 3 && x <= 5 && y >= 2 && y <= 6;
				data.set(inside ? [255, 0, 0, 255] : background, index * 4);
			});
			if (background[3] === 7) data.set([1, 2, 3, 4], 0);
			return Promise.resolve(data);
		};

	const SMALL = svg(
		'viewBox="0 0 16 10"',
		'  <g id="layer-1" draw:kind="vector"><rect width="16" height="10"/></g>'
	);

	it('cuts to what is not the top left’s color, in the drawing as rendered', async () => {
		const document = open(SMALL);
		const asked: unknown[] = [];
		expect(
			await trimCanvas(
				document,
				'topLeft',
				ALL_SIDES,
				extentFrom({}),
				blockComposite([255, 255, 255, 255], asked)
			)
		).toBe('done');
		expect(asked).toEqual([
			{ box: { x: 0, y: 0, width: 16, height: 10 }, width: 16, height: 10 },
		]);
		expect(document.root.getAttribute('viewBox')).toBe('3 2 3 5');
		document.undo();
		expect(document.text()).toBe(SMALL);
	});

	it('reads the bottom right’s color for that basis', async () => {
		const document = open(SMALL);
		// The top left pixel differs from the rest, so only the bottom right's color trims to the block and it.
		expect(
			await trimCanvas(
				document,
				'bottomRight',
				ALL_SIDES,
				extentFrom({}),
				blockComposite([9, 9, 9, 7])
			)
		).toBe('done');
		expect(document.root.getAttribute('viewBox')).toBe('0 0 6 7');
		const top = open(SMALL);
		await trimCanvas(top, 'topLeft', ALL_SIDES, extentFrom({}), blockComposite([9, 9, 9, 7]));
		expect(top.root.getAttribute('viewBox')).toBe('0 0 16 10');
	});

	it('says so where the drawing cannot be rendered, or changed while it was', async () => {
		const document = open(SMALL);
		expect(
			await trimCanvas(document, 'topLeft', ALL_SIDES, extentFrom({}), () =>
				Promise.resolve(undefined)
			)
		).toBe('unrenderable');
		expect(await trimCanvas(document, 'topLeft', ALL_SIDES, extentFrom({}))).toBe(
			'unrenderable'
		);
		const changing = open(TRIMMED);
		const extent: LayerExtent = (id) => {
			if (id === 'layer-1') changing.execute(renameLayer('layer-1', 'Meanwhile'));
			return Promise.resolve({ x: 10, y: 10, width: 10, height: 10 });
		};
		expect(await trimCanvas(changing, 'transparent', ALL_SIDES, extent)).toBe('changed');
		expect(changing.root.getAttribute('viewBox')).toBe('0 0 1600 1000');
	});

	it('is labeled as Trim', async () => {
		const document = open(TRIMMED);
		await trimCanvas(
			document,
			'transparent',
			ALL_SIDES,
			extentFrom({ 'layer-1': { x: 1, y: 1, width: 5, height: 5 } })
		);
		expect(document.snapshot().canUndo).toBe(true);
		const labels: string[] = [];
		const spy = { ...document, execute: (command: Command) => labels.push(command.label) };
		await trimCanvas(
			spy,
			'transparent',
			ALL_SIDES,
			extentFrom({ 'layer-1': { x: 2, y: 2, width: 2, height: 2 } })
		);
		expect(labels).toEqual(['image.undo.trim']);
	});
});

describe('Reveal All', () => {
	it('grows the canvas to hold every shown layer’s paint, outward to whole units', async () => {
		const document = open(TRIMMED);
		const labels: string[] = [];
		const extent = extentFrom({
			'layer-1': { x: -20.5, y: 10, width: 50, height: 50 },
			'layer-2': { x: -5000, y: -5000, width: 10, height: 10 },
			'layer-3': { x: 1590, y: 990, width: 30.2, height: 30 },
		});
		const spy = {
			...document,
			execute: (command: Command) => {
				labels.push(command.label);
				document.execute(command);
			},
		};
		expect(await revealAll(spy, extent)).toBe('done');
		expect(labels).toEqual(['image.undo.revealAll']);
		expect(document.root.getAttribute('viewBox')).toBe('-21 0 1642 1020');
		expect(document.root.getAttribute('height')).toBe('1020');
		document.undo();
		expect(document.text()).toBe(TRIMMED);
	});

	it('does nothing where everything is on the canvas already', async () => {
		const document = open(TRIMMED);
		expect(
			await revealAll(
				document,
				extentFrom({ 'layer-1': { x: 0, y: 0, width: 1600, height: 1000.0000001 } })
			)
		).toBe('nothing');
		expect(await revealAll(document, extentFrom({}))).toBe('nothing');
		expect(document.snapshot().dirty).toBe(false);
	});
});

describe('the clip of a layer the Image operations move', () => {
	/** A shape, and a picture moved over it and clipped to it, its use undoing the move. */
	const CLIPPED = svg(
		'viewBox="0 0 400 300" width="400" height="300"',
		`  <defs><mask id="clip-layer-2" style="mask-type:alpha"><use href="#layer-1" transform="translate(-40 -10)"/></mask></defs>
  <g id="layer-1" draw:kind="vector" transform="translate(10 20)"><rect width="100" height="100"/></g>
  <g id="layer-2" draw:kind="raster" transform="translate(40 10)" mask="url(#clip-layer-2)"><image href="${PICTURE}" x="0" y="0" width="200" height="100" preserveAspectRatio="none"/></g>`
	);

	const clipUseTransform = (document: EditorDocument): Mat =>
		parseTransform(
			byId(document, 'clip-layer-2').querySelector('use')?.getAttribute('transform') ?? null
		);

	it.each([
		[
			'a quarter turn',
			(live: SVGSVGElement) => turnCanvas(live, { width: 400, height: 300 }, 'rotate90cw'),
		],
		[
			'a turn of 30°',
			(live: SVGSVGElement) => rotateCanvas(live, { width: 400, height: 300 }, 30),
		],
		[
			'a flip',
			(live: SVGSVGElement) => turnCanvas(live, { width: 400, height: 300 }, 'flipVertical'),
		],
	])(
		'keeps the use the inverse of the layer’s transform through %s, one undo taking both back',
		(_name, make) => {
			const document = open(CLIPPED);
			document.execute(make(document.root));
			expectMatrix(
				clipUseTransform(document),
				invert(parseTransform(byId(document, 'layer-2').getAttribute('transform')))
			);
			expectMatrix(clipPlace(document, 'layer-2'), placeOfId(document, 'layer-1'));
			document.undo();
			expect(document.text()).toBe(CLIPPED);
		}
	);

	it('keeps it as Image Size makes a clipped picture again, which changes its layer’s transform too', async () => {
		const document = open(CLIPPED);
		expect(
			await resizeImage(
				document,
				{ width: 600, height: 450, resample: true },
				fakeResampler({ width: 200, height: 100 })
			)
		).toBe('done');
		expect(imageOfLayer(document, 'layer-2').getAttribute('width')).toBe('300');
		expectMatrix(
			clipUseTransform(document),
			invert(parseTransform(byId(document, 'layer-2').getAttribute('transform')))
		);
		expectMatrix(clipPlace(document, 'layer-2'), placeOfId(document, 'layer-1'));
		document.undo();
		expect(document.text()).toBe(CLIPPED);
	});
});
