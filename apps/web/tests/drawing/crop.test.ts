import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { afterEach, describe, expect, it } from 'vitest';

import { canvasBoxOf, cropCanvas } from '../../src/drawing/document/crop.js';
import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { cropBehaviour, draggedBox, gripAt } from '../../src/drawing/tools/common/crop.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type ToolBehaviour,
	type ToolContext,
} from '../../src/drawing/tools/types.js';

/**
 * The crop (docs/decisions/0004-the-interface.md: "Crop C: the canvas's
 * `viewBox`"): the box's arithmetic, the command that sets the canvas, and
 * the tool that drags a box and applies it with Enter or a double-click.
 */

afterEach(() => {
	window.document.body.replaceChildren();
});

const BOX = { x: 10, y: 20, width: 100, height: 50 };

describe('what a press is on', () => {
	it.each([
		[{ x: 10, y: 20 }, 'nw'],
		[{ x: 111, y: 71 }, 'se'],
		[{ x: 60, y: 21 }, 'n'],
		[{ x: 9, y: 40 }, 'w'],
		[{ x: 60, y: 40 }, 'inside'],
		[{ x: 200, y: 40 }, 'outside'],
		[{ x: 60, y: 90 }, 'outside'],
	])('at %o, it is %s', (point, grip) => {
		expect(gripAt(BOX, point, 4)).toBe(grip);
	});
});

describe('the box a drag makes', () => {
	const start = { x: 10, y: 10 };

	it('is from where a new one began to the pointer, either way round', () => {
		expect(draggedBox({ grip: 'new', start, from: BOX }, { x: 4, y: 30 }, undefined)).toEqual({
			x: 4,
			y: 10,
			width: 6,
			height: 20,
		});
	});

	it('keeps the proportions asked for, sized by the longer way the pointer went', () => {
		expect(draggedBox({ grip: 'new', start, from: BOX }, { x: 50, y: 15 }, 2)).toEqual({
			x: 10,
			y: 10,
			width: 40,
			height: 20,
		});
	});

	it('moves with its inside, and sizes from the handle against the opposite corner', () => {
		expect(
			draggedBox({ grip: 'inside', start, from: BOX }, { x: 15, y: 5 }, undefined)
		).toEqual({
			...BOX,
			x: 15,
			y: 15,
		});
		expect(draggedBox({ grip: 'se', start, from: BOX }, { x: 0, y: 20 }, undefined)).toEqual({
			x: 10,
			y: 20,
			width: 90,
			height: 60,
		});
	});

	it('sizes the other way about the middle when a side is kept in proportion', () => {
		expect(draggedBox({ grip: 'e', start, from: BOX }, { x: 110, y: 10 }, 2)).toEqual({
			x: 10,
			y: -5,
			width: 200,
			height: 100,
		});
	});
});

const DRAWING = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="d1" viewBox="0 0 210 297" width="210mm" height="297mm">
  <g id="layer-1" draw:kind="vector"><rect width="10" height="10"/></g>
</svg>
`;

const open = (text = DRAWING): EditorDocument => {
	const document = openDocument(text);
	if (document === undefined) throw new Error('the drawing opens');
	return document;
};

describe('the crop command', () => {
	it('sets the viewBox, scales the size in its own unit, and undoes to the bytes', () => {
		const document = open();
		const from = canvasBoxOf(document.root, document.size);
		document.execute(cropCanvas({ x: 10, y: 20, width: 105, height: 148.5 }, from));
		expect(document.root.getAttribute('viewBox')).toBe('10 20 105 148.5');
		expect(document.root.getAttribute('width')).toBe('105mm');
		expect(document.root.getAttribute('height')).toBe('148.5mm');
		// The canvas the tools and the viewport size things by follows it.
		expect(document.size).toEqual({ width: 105, height: 148.5 });
		expect(document.snapshot().size).toEqual({ width: 105, height: 148.5 });
		document.undo();
		expect(document.text()).toBe(DRAWING);
		expect(document.size).toEqual({ width: 210, height: 297 });
	});

	it('gives a file with no viewBox one, sized from its own width and height', () => {
		const text = `<svg xmlns="${SVG_NAMESPACE}" width="200" height="300"><g/></svg>`;
		const document = open(text);
		const from = canvasBoxOf(document.root, document.size);
		document.execute(cropCanvas({ x: 0, y: 0, width: 50, height: 150 }, from));
		expect(document.root.getAttribute('width')).toBe('50');
		expect(document.root.getAttribute('height')).toBe('150');
		expect(document.root.getAttribute('viewBox')).toBe('0 0 50 150');
		document.undo();
		expect(document.text()).toBe(text);
	});

	it('leaves a size in percent as it is', () => {
		const text = `<svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 200 300" width="100%" height="300px"><g/></svg>`;
		const document = open(text);
		const from = canvasBoxOf(document.root, document.size);
		document.execute(cropCanvas({ x: 0, y: 0, width: 50, height: 150 }, from));
		expect(document.root.getAttribute('width')).toBe('100%');
		expect(document.root.getAttribute('height')).toBe('150px');
	});
});

/** A context as the viewport makes one, at a scale of one screen pixel per unit. */
const contextFor = (
	document: EditorDocument,
	constrain = false
): ToolContext & Readonly<{ host: HTMLElement; overlay: SVGSVGElement }> => {
	const host = window.document.createElement('div');
	const overlay = window.document.createElementNS(SVG_NAMESPACE, 'svg');
	host.appendChild(overlay);
	window.document.body.appendChild(host);
	return {
		document,
		layer: undefined,
		options: { ...DEFAULT_TOOL_OPTIONS, constrain },
		overlay,
		screen: {
			canvas: window.document.createElement('canvas'),
			toScreen: (x, y) => [x, y],
			pixelRatio: 1,
		},
		viewport: {
			scale: 1,
			zoomBy: () => undefined,
			panBy: () => undefined,
			fit: () => undefined,
			actualSize: () => undefined,
		},
		selection: { elements: [], set: () => undefined, clear: () => undefined },
		region: { path: undefined, set: () => undefined },
		host,
		setColour: () => undefined,
		notify: () => undefined,
	};
};

const sample = (x: number, y: number): PointerSample => ({
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

const behaviour = (): ToolBehaviour => {
	const made = cropBehaviour();
	if (made === undefined) throw new Error('the crop has a behaviour');
	return made;
};

const drag = (
	crop: ToolBehaviour,
	context: ToolContext,
	from: readonly [number, number],
	to: readonly [number, number]
) => {
	crop.begin(context, sample(...from));
	crop.move(context, sample((from[0] + to[0]) / 2, (from[1] + to[1]) / 2));
	crop.move(context, sample(...to));
	crop.end(context, sample(...to));
};

const press = (key: string) => {
	window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
};

describe('the crop tool', () => {
	it('shows the box over the darkened outside, and applies it with Enter as one step', () => {
		const document = open();
		const crop = behaviour();
		const context = contextFor(document);
		drag(crop, context, [50, 60], [150, 260]);
		expect(context.overlay.querySelector('.crop-overlay .crop-shade')).not.toBeNull();
		expect(context.overlay.querySelector('.crop-frame')?.getAttribute('width')).toBe('100');
		expect(context.overlay.querySelectorAll('.crop-handle')).toHaveLength(8);
		expect(document.root.getAttribute('viewBox')).toBe('0 0 210 297');

		press('Enter');
		expect(document.root.getAttribute('viewBox')).toBe('50 60 100 200');
		expect(context.overlay.querySelector('.crop-overlay')).toBeNull();
		document.undo();
		expect(document.text()).toBe(DRAWING);
	});

	it('moves the box by its inside and sizes it by a handle before it is applied', () => {
		const document = open();
		const crop = behaviour();
		const context = contextFor(document);
		drag(crop, context, [50, 60], [150, 260]);
		drag(crop, context, [100, 100], [110, 90]);
		drag(crop, context, [160, 250], [170, 250]);
		context.host.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		expect(document.root.getAttribute('viewBox')).toBe('60 50 110 200');
	});

	it("drags the canvas's own edge in before any box is drawn, kept in proportion", () => {
		const document = open();
		const crop = behaviour();
		const context = contextFor(document, true);
		drag(crop, context, [210, 297], [105, 200]);
		press('Enter');
		const [x, y, width, height] = (document.root.getAttribute('viewBox') ?? '')
			.split(' ')
			.map(Number);
		expect([x, y]).toEqual([0, 0]);
		expect((width ?? 0) / (height ?? 1)).toBeCloseTo(210 / 297, 3);
	});

	it('lets the box go with Escape, with another tool, and with a click that drew nothing', () => {
		const document = open();
		const crop = behaviour();
		const context = contextFor(document);
		drag(crop, context, [50, 60], [150, 260]);
		press('Escape');
		expect(context.overlay.querySelector('.crop-overlay')).toBeNull();
		press('Enter');
		expect(document.snapshot().canUndo).toBe(false);

		drag(crop, context, [50, 60], [150, 260]);
		// The viewport empties the overlay when the tool changes.
		context.overlay.replaceChildren();
		press('Enter');
		expect(document.snapshot().canUndo).toBe(false);

		drag(crop, context, [50, 60], [150, 260]);
		// Told once the stroke is over, as the viewport may when the tool is put down.
		crop.cancel(context);
		expect(context.overlay.querySelector('.crop-overlay')).toBeNull();

		drag(crop, context, [50, 60], [50, 60]);
		expect(context.overlay.querySelector('.crop-overlay')).toBeNull();

		// A click outside a box drawn before keeps it.
		drag(crop, context, [50, 60], [150, 260]);
		drag(crop, context, [190, 20], [190, 20]);
		expect(context.overlay.querySelector('.crop-frame')?.getAttribute('x')).toBe('50');
	});

	it('leaves Enter to a field being typed in, and to a control that has the focus', () => {
		const document = open();
		const crop = behaviour();
		const context = contextFor(document);
		drag(crop, context, [50, 60], [150, 260]);
		const button = window.document.createElement('button');
		window.document.body.appendChild(button);
		button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		const field = window.document.createElement('input');
		window.document.body.appendChild(field);
		field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		expect(document.snapshot().canUndo).toBe(false);
		context.host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		expect(document.snapshot().canUndo).toBe(true);
	});
});
