import { DEFAULT_DRAWING_SIZE, emptyDrawing, SVG_NAMESPACE } from '@skysa/draw-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Command, EditorDocument, LayerInfo } from '../../src/drawing/document/model.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type ToolBehaviour,
	type ToolContext,
	type ToolOptions,
} from '../../src/drawing/tools/types.js';
import { createPen } from '../../src/drawing/tools/vector/pen.js';
import { t } from '../../src/i18n/t.js';

/**
 * The pen (docs/decisions/0004-the-interface.md) against a fake editor, as
 * the other vector tools are tested (`vector.test.ts`): a real SVG document, a
 * document whose `execute` applies a command at once and remembers its label,
 * and the commands mocked to the contract the tools rely on. The overlay is in
 * the page, as the viewport's is, since the pen hears Enter and Escape on the
 * document while a path is drawn.
 */

vi.mock('../../src/drawing/document/commands.js', () => ({
	editLayer: (id: string, label: string, mutate: (layer: SVGGraphicsElement) => void) => ({
		label,
		bytes: 0,
		apply: (root: SVGSVGElement) => {
			const layer = root.ownerDocument.getElementById(id);
			if (layer !== null) mutate(layer as unknown as SVGGraphicsElement);
		},
		revert: () => undefined,
	}),
	wrapLooseLayer: (root: SVGSVGElement, id: string) => ({
		id: 'layer-9',
		label: 'layers.wrap',
		bytes: 0,
		apply: () => {
			const loose = root.ownerDocument.getElementById(id);
			if (loose === null) return;
			const g = root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
			g.setAttribute('id', 'layer-9');
			loose.replaceWith(g);
			g.appendChild(loose);
		},
		revert: () => undefined,
	}),
}));

const noop = (): undefined => undefined;

const layerInfo = (id: string, overrides: Partial<LayerInfo> = {}): LayerInfo => ({
	id,
	kind: 'vector',
	name: undefined,
	hidden: false,
	locked: false,
	opacity: 1,
	blend: 'normal',
	depth: 0,
	parentId: undefined,
	loose: false,
	...overrides,
});

const createDrawing = () => {
	const parsed = new DOMParser().parseFromString(emptyDrawing({ id: 'd-1' }), 'image/svg+xml');
	const root = parsed.documentElement as unknown as SVGSVGElement;
	const layer = parsed.getElementById('layer-1');
	if (layer === null) throw new Error('an empty drawing starts with layer-1');
	return { root, layer, owner: parsed };
};

const createFake = (
	root: SVGSVGElement,
	layers: LayerInfo[],
	active: LayerInfo | undefined,
	options: Partial<ToolOptions> = {},
	scale = 1
) => {
	const labels: string[] = [];
	const notices: string[] = [];
	const onExecute: { current: (() => void) | undefined } = { current: undefined };
	const selected: { current: readonly Element[] } = { current: [] };
	const editor: EditorDocument = {
		root,
		prolog: '',
		size: DEFAULT_DRAWING_SIZE,
		snapshot: () => ({
			layers,
			size: DEFAULT_DRAWING_SIZE,
			canUndo: false,
			canRedo: false,
			dirty: false,
			version: 0,
		}),
		text: () => new XMLSerializer().serializeToString(root),
		layer: (id) =>
			(root.ownerDocument.getElementById(id) as unknown as SVGGraphicsElement | null) ??
			undefined,
		execute: (command: Command) => {
			labels.push(command.label);
			onExecute.current?.();
			command.apply(root);
		},
		undo: noop,
		redo: noop,
		subscribe: () => noop,
		pending: noop,
		settle: () => Promise.resolve(),
	};
	const overlay = document.createElementNS(SVG_NAMESPACE, 'svg');
	document.body.appendChild(overlay);
	const context: ToolContext = {
		document: editor,
		layer: active,
		options: { ...DEFAULT_TOOL_OPTIONS, ...options },
		overlay,
		screen: {
			canvas: document.createElement('canvas'),
			toScreen: (x, y) => [x, y],
			pixelRatio: 1,
		},
		viewport: { scale, zoomBy: noop, panBy: noop, fit: noop, actualSize: noop },
		region: { path: undefined, set: noop },
		host: document.createElement('div'),
		selection: {
			get elements() {
				return selected.current;
			},
			set: (elements) => {
				selected.current = elements;
			},
			clear: () => {
				selected.current = [];
			},
		},
		setColour: noop,
		notify: (message) => notices.push(message),
	};
	return { context, labels, notices, onExecute };
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

const click = (
	pen: ToolBehaviour,
	context: ToolContext,
	x: number,
	y: number,
	extra: Partial<PointerSample> = {}
): void => {
	pen.begin(context, at(x, y, extra));
	pen.end(context, at(x, y, extra));
};

const drag = (
	pen: ToolBehaviour,
	context: ToolContext,
	from: readonly [number, number],
	to: readonly [number, number],
	extra: Partial<PointerSample> = {}
): void => {
	pen.begin(context, at(from[0], from[1]));
	pen.move(context, at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, extra));
	pen.move(context, at(to[0], to[1], extra));
	pen.end(context, at(to[0], to[1], extra));
};

const press = (key: string, target: EventTarget = document): void => {
	target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
};

/** A turn of the event loop: the overlay's observer and a cancel's restoring run in microtasks. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const setUp = (options: Partial<ToolOptions> = {}) => {
	const drawing = createDrawing();
	const info = layerInfo('layer-1');
	return { ...drawing, ...createFake(drawing.root, [info], info, options), pen: createPen() };
};

afterEach(() => {
	// An overlay out of the page tells a pen left drawing that the editor is gone.
	document.body.replaceChildren();
});

describe('the pen', () => {
	it('makes straight segments of clicks, written by one command when Enter finishes the path', () => {
		const { context, labels, layer, pen } = setUp({
			fill: 'none',
			stroke: '#ff0000',
			strokeWidth: 3,
		});
		click(pen, context, 10, 10);
		click(pen, context, 50, 10);
		click(pen, context, 50, 50);
		expect(labels).toEqual([]);
		expect(layer.children.length).toBe(0);
		expect(context.overlay.children.length).toBe(1);
		press('Enter');
		expect(labels).toEqual(['tools.pen']);
		const path = layer.firstElementChild;
		expect(path?.localName).toBe('path');
		expect(path?.getAttribute('d')).toBe('M 10 10 L 50 10 L 50 50');
		expect(path?.getAttribute('fill')).toBe('none');
		expect(path?.getAttribute('stroke')).toBe('#ff0000');
		expect(path?.getAttribute('stroke-width')).toBe('3');
		expect(context.overlay.children.length).toBe(0);
	});

	it('leaves the layer untouched until the one command', () => {
		const { context, layer, onExecute, pen } = setUp();
		const seen: number[] = [];
		onExecute.current = () => seen.push(layer.children.length);
		click(pen, context, 0, 0);
		click(pen, context, 30, 0);
		press('Enter');
		expect(seen).toEqual([0]);
		expect(layer.children.length).toBe(1);
	});

	it('makes a smooth point of a press and drag, its handles mirroring the drag', () => {
		const { context, layer, pen } = setUp();
		click(pen, context, 10, 10);
		drag(pen, context, [50, 10], [70, 10]);
		click(pen, context, 90, 50);
		press('Enter');
		expect(layer.firstElementChild?.getAttribute('d')).toBe(
			'M 10 10 C 10 10 30 10 50 10 C 70 10 90 50 90 50'
		);
	});

	it('breaks the mirror with Alt, the handle the path goes on by moving alone', () => {
		const { context, layer, pen } = setUp();
		click(pen, context, 10, 10);
		pen.begin(context, at(50, 10));
		pen.move(context, at(70, 10));
		pen.move(context, at(70, 30, { altKey: true }));
		pen.end(context, at(70, 30, { altKey: true }));
		click(pen, context, 90, 50);
		press('Enter');
		expect(layer.firstElementChild?.getAttribute('d')).toBe(
			'M 10 10 C 10 10 30 10 50 10 C 70 30 90 50 90 50'
		);
	});

	it('keeps a new segment to 45° with Shift', () => {
		const { context, layer, pen } = setUp();
		click(pen, context, 0, 0);
		click(pen, context, 100, 10, { shiftKey: true });
		click(pen, context, 140, 48, { shiftKey: true });
		press('Enter');
		const d = layer.firstElementChild?.getAttribute('d') ?? '';
		const [, x1 = '', y1 = '', x2 = '', y2 = ''] =
			/^M 0 0 L ([\d.]+) ([\d.]+) L ([\d.]+) ([\d.]+)$/.exec(d) ?? [];
		expect(Number(y1)).toBe(0);
		expect(Number(x1)).toBeCloseTo(100.5, 2);
		// From there, (39.5, 48) snaps to the diagonal.
		expect(Number(x2) - Number(x1)).toBeCloseTo(Number(y2), 1);
	});

	it('closes the path on its first point, with Z, at once', () => {
		const { context, labels, layer, pen } = setUp({ fill: '#00ff00', stroke: 'none' });
		click(pen, context, 0, 0);
		click(pen, context, 100, 0);
		click(pen, context, 100, 100);
		click(pen, context, 2, 1);
		expect(labels).toEqual(['tools.pen']);
		const path = layer.firstElementChild;
		expect(path?.getAttribute('d')).toBe('M 0 0 L 100 0 L 100 100 Z');
		expect(path?.getAttribute('fill')).toBe('#00ff00');
		// A closed path with a fill shows it, and is not given a stroke.
		expect(path?.hasAttribute('stroke')).toBe(false);
		expect(context.overlay.children.length).toBe(0);
	});

	it('finishes an open path on a second click on its last point, as a double-click', () => {
		const { context, labels, layer, pen } = setUp();
		click(pen, context, 0, 0);
		click(pen, context, 50, 0);
		click(pen, context, 50, 0);
		expect(labels).toEqual(['tools.pen']);
		expect(layer.firstElementChild?.getAttribute('d')).toBe('M 0 0 L 50 0');
		expect(context.overlay.children.length).toBe(0);
	});

	it('strokes an open path in the fill colour where there is no stroke colour, which would show nothing', () => {
		const { context, layer, pen } = setUp({ fill: '#123456', stroke: 'none', strokeWidth: 4 });
		click(pen, context, 0, 0);
		click(pen, context, 50, 0);
		press('Enter');
		const path = layer.firstElementChild;
		expect(path?.getAttribute('stroke')).toBe('#123456');
		expect(path?.getAttribute('stroke-width')).toBe('4');
	});

	it('keeps what is drawn on Escape, and drops a path of one point', () => {
		const kept = setUp();
		click(kept.pen, kept.context, 0, 0);
		click(kept.pen, kept.context, 40, 0);
		press('Escape');
		expect(kept.labels).toEqual(['tools.pen']);
		expect(kept.layer.firstElementChild?.getAttribute('d')).toBe('M 0 0 L 40 0');
		expect(kept.context.overlay.children.length).toBe(0);

		const dropped = setUp();
		click(dropped.pen, dropped.context, 0, 0);
		press('Escape');
		expect(dropped.labels).toEqual([]);
		expect(dropped.layer.children.length).toBe(0);
		expect(dropped.context.overlay.children.length).toBe(0);
	});

	it('lets go of the point under way on Escape mid-press, and keeps the rest', () => {
		const { context, layer, pen } = setUp();
		click(pen, context, 0, 0);
		click(pen, context, 40, 0);
		pen.begin(context, at(80, 0));
		press('Escape');
		// The viewport cancels the stroke it had under way too.
		pen.cancel(context);
		pen.end(context, at(80, 0));
		expect(layer.firstElementChild?.getAttribute('d')).toBe('M 0 0 L 40 0');
	});

	it('carries on after a cancel, a second finger say, losing only the press under way', async () => {
		const { context, labels, layer, pen } = setUp();
		click(pen, context, 0, 0);
		pen.begin(context, at(50, 50));
		pen.cancel(context);
		// The viewport empties the overlay after a cancel.
		context.overlay.replaceChildren();
		await settle();
		expect(labels).toEqual([]);
		expect(context.overlay.children.length).toBe(1);
		click(pen, context, 60, 0);
		press('Enter');
		expect(layer.firstElementChild?.getAttribute('d')).toBe('M 0 0 L 60 0');
	});

	it('finishes the path when the overlay is emptied under it, the tool or the layer changed', async () => {
		const { context, labels, layer, pen } = setUp();
		click(pen, context, 0, 0);
		click(pen, context, 25, 0);
		context.overlay.replaceChildren();
		await settle();
		expect(labels).toEqual(['tools.pen']);
		expect(layer.firstElementChild?.getAttribute('d')).toBe('M 0 0 L 25 0');
		press('Enter');
		expect(labels).toEqual(['tools.pen']);
	});

	it('shows the segment to the pointer, and a closing segment over the first point', () => {
		const { context, pen } = setUp();
		click(pen, context, 0, 0);
		pen.hover?.(context, at(40, 30));
		const ds = (): (string | null)[] =>
			[...context.overlay.querySelectorAll('path')].map((path) => path.getAttribute('d'));
		expect(ds()).toContain('M 0 0 L 40 30');
		click(pen, context, 40, 30);
		click(pen, context, 80, 0);
		pen.hover?.(context, at(1, 1));
		expect(ds()).toContain('M 80 0 L 0 0');
		expect(context.overlay.querySelectorAll('[data-anchor]').length).toBe(3);
		press('Escape');
	});

	it('sizes its marks to stay the same on screen', () => {
		const { context, pen } = setUp();
		const zoomed = { ...context, viewport: { ...context.viewport, scale: 4 } };
		click(pen, zoomed, 0, 0);
		expect(context.overlay.querySelector('[data-anchor]')?.getAttribute('width')).toBe('1.75');
		press('Escape');
	});

	it('ignores Enter typed into a field', () => {
		const { context, labels, pen } = setUp();
		click(pen, context, 0, 0);
		click(pen, context, 25, 0);
		const field = document.createElement('input');
		document.body.appendChild(field);
		press('Enter', field);
		expect(labels).toEqual([]);
		press('Enter');
		expect(labels).toEqual(['tools.pen']);
	});

	it('draws in the layer’s own units on a moved layer', () => {
		const { context, layer, pen } = setUp();
		layer.setAttribute('transform', 'translate(100, 50)');
		click(pen, context, 110, 60);
		click(pen, context, 120, 60);
		press('Enter');
		expect(layer.firstElementChild?.getAttribute('d')).toBe('M 10 10 L 20 10');
	});

	it('wraps a loose element in a layer before drawing into it', () => {
		const { root, owner } = createDrawing();
		const loose = owner.createElementNS(SVG_NAMESPACE, 'rect');
		loose.setAttribute('id', 'r1');
		root.appendChild(loose);
		const info = layerInfo('r1', { loose: true });
		const { context, labels } = createFake(root, [layerInfo('layer-1'), info], info);
		const pen = createPen();
		click(pen, context, 0, 0);
		click(pen, context, 10, 0);
		press('Enter');
		expect(labels).toEqual(['layers.wrap', 'tools.pen']);
		expect(owner.getElementById('layer-9')?.lastElementChild?.getAttribute('d')).toBe(
			'M 0 0 L 10 0'
		);
	});

	it('says so and draws nothing without an active layer, or on a locked one', () => {
		const { root } = createDrawing();
		const none = createFake(root, [layerInfo('layer-1')], undefined);
		const pen = createPen();
		click(pen, none.context, 0, 0);
		expect(none.notices).toEqual([t('layers.noneActive')]);
		expect(none.context.overlay.children.length).toBe(0);

		const locked = layerInfo('layer-1', { locked: true });
		const fake = createFake(root, [locked], locked);
		click(pen, fake.context, 0, 0);
		click(pen, fake.context, 10, 0);
		press('Enter');
		expect(fake.notices).toEqual([
			t('layers.locked', { name: 'Layer 1' }),
			t('layers.locked', { name: 'Layer 1' }),
		]);
		expect(fake.labels).toEqual([]);
		expect(fake.context.overlay.children.length).toBe(0);
	});

	it('finishes a path on its own layer when another is made active', () => {
		const { root, layer, owner } = createDrawing();
		const other = owner.createElementNS(SVG_NAMESPACE, 'g');
		other.setAttribute('id', 'layer-2');
		root.appendChild(other);
		const first = layerInfo('layer-1');
		const second = layerInfo('layer-2');
		const one = createFake(root, [first, second], first);
		const pen = createPen();
		click(pen, one.context, 0, 0);
		click(pen, one.context, 10, 0);
		const two = createFake(root, [first, second], second);
		click(pen, two.context, 50, 50);
		expect(one.labels).toEqual(['tools.pen']);
		expect(layer.firstElementChild?.getAttribute('d')).toBe('M 0 0 L 10 0');
		expect(other.children.length).toBe(0);
		press('Escape');
	});
});
