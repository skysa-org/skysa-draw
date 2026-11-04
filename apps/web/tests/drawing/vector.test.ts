import { DEFAULT_DRAWING_SIZE, emptyDrawing, SVG_NAMESPACE } from '@skysa/draw-core';
import { describe, expect, it, vi } from 'vitest';

import type { Command, EditorDocument, LayerInfo } from '../../src/drawing/document/model.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type ToolBehaviour,
	type ToolContext,
	type ToolOptions,
} from '../../src/drawing/tools/types.js';
import {
	apply,
	parseTransform,
	type Point,
	rotate,
} from '../../src/drawing/tools/vector/geometry.js';
import { createVectorBehaviours, deleteSelection } from '../../src/drawing/tools/vector/index.js';
import { attributeBox, measureOf } from '../../src/drawing/tools/vector/measure.js';
import { t } from '../../src/i18n/t.js';

/**
 * The vector tools (docs/decisions/0004-the-interface.md) against a fake
 * editor: a real SVG document, a document whose `execute` applies a command at
 * once and remembers its label, and a measurer that reads boxes from
 * attributes, since jsdom has no `getBBox()`. The commands module is the other
 * half of the editor and is mocked here to the contract the tools rely on: a
 * command whose `apply` runs the mutation on the layer found by id.
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

const svg = (owner: Document, name: string, attributes: Record<string, string>): Element => {
	const element = owner.createElementNS(SVG_NAMESPACE, name);
	Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
	return element;
};

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

/** A new drawing, whose one vector layer, `layer-1`, is given `children`. */
const createDrawing = (children: Record<string, string>[] = []) => {
	const parsed = new DOMParser().parseFromString(emptyDrawing({ id: 'd-1' }), 'image/svg+xml');
	const root = parsed.documentElement as unknown as SVGSVGElement;
	const layer = parsed.getElementById('layer-1');
	if (layer === null) throw new Error('an empty drawing starts with layer-1');
	children.forEach(({ tag = 'rect', ...attributes }) =>
		layer.appendChild(svg(parsed, tag, attributes))
	);
	return { root, layer, owner: parsed };
};

type Fake = Readonly<{
	context: ToolContext;
	labels: string[];
	/** Every command executed, to be applied again as a redo would. */
	commands: Command[];
	notices: string[];
	colours: [string, string][];
	/** Called by `execute` before the command applies: what the layer looked like then. */
	onExecute: { current: (() => void) | undefined };
}>;

const createFake = (
	root: SVGSVGElement,
	layers: LayerInfo[],
	active: LayerInfo | undefined,
	options: Partial<ToolOptions> = {},
	scale = 1
): Fake => {
	const labels: string[] = [];
	const commands: Command[] = [];
	const notices: string[] = [];
	const colours: [string, string][] = [];
	const onExecute: Fake['onExecute'] = { current: undefined };
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
			commands.push(command);
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
		setColour: (which, value) => colours.push([which, value]),
		notify: (message) => notices.push(message),
	};
	return { context, labels, commands, notices, colours, onExecute };
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

/** A whole stroke: begin at the first point, move through the rest, end at the last. */
const stroke = (
	behaviour: ToolBehaviour,
	context: ToolContext,
	points: readonly Point[],
	extra: Partial<PointerSample> = {}
): void => {
	const [first, ...rest] = points;
	if (first === undefined) return;
	behaviour.begin(context, at(first.x, first.y, extra));
	rest.forEach((p) => behaviour.move(context, at(p.x, p.y, extra)));
	const last = rest.at(-1) ?? first;
	behaviour.end(context, at(last.x, last.y, extra));
};

const tools = createVectorBehaviours({ measure: attributeBox });

const tool = (name: keyof typeof tools): ToolBehaviour => {
	const behaviour = tools[name];
	if (behaviour === undefined) throw new Error(`no ${name}`);
	return behaviour;
};

const WAVE: Point[] = [
	{ x: 10, y: 10 },
	{ x: 20, y: 14 },
	{ x: 30, y: 9 },
	{ x: 40, y: 16 },
	{ x: 50, y: 11 },
];

describe('the guard', () => {
	it('says so and draws nothing without an active layer', () => {
		const { root, layer } = createDrawing();
		const { context, notices, labels } = createFake(root, [layerInfo('layer-1')], undefined);
		stroke(tool('pencil'), context, WAVE);
		expect(notices).toEqual([t('layers.noneActive')]);
		expect(labels).toEqual([]);
		expect(layer.children.length).toBe(0);
		expect(context.overlay.children.length).toBe(0);
	});

	it('says which layer is locked, by its number, and draws nothing', () => {
		const { root, layer } = createDrawing();
		const locked = layerInfo('layer-1', { locked: true });
		const { context, notices, labels } = createFake(root, [locked], locked);
		stroke(tool('pencil'), context, WAVE);
		expect(notices).toEqual([t('layers.locked', { name: 'Layer 1' })]);
		expect(labels).toEqual([]);
		expect(layer.children.length).toBe(0);
	});

	it('says a hidden layer is hidden, by the name it was given', () => {
		const { root } = createDrawing();
		const hidden = layerInfo('layer-1', { hidden: true, name: 'Sketch' });
		const { context, notices, labels } = createFake(root, [hidden], hidden);
		stroke(tool('brush'), context, WAVE);
		expect(notices).toEqual([t('layers.hidden', { name: 'Sketch' })]);
		expect(labels).toEqual([]);
	});

	it('wraps a loose element in a layer before drawing into it', () => {
		const { root, owner } = createDrawing();
		const loose = svg(owner, 'rect', { id: 'r1', x: '0', y: '0', width: '10', height: '10' });
		root.appendChild(loose);
		const info = layerInfo('r1', { loose: true });
		const { context, labels } = createFake(root, [layerInfo('layer-1'), info], info);
		stroke(tool('pencil'), context, WAVE);
		expect(labels).toEqual(['layers.wrap', 'tools.pencil']);
		const wrapped = owner.getElementById('layer-9');
		expect(wrapped?.children.length).toBe(2);
		expect(wrapped?.firstElementChild).toBe(loose);
		expect(wrapped?.lastElementChild?.localName).toBe('path');
	});

	it('draws in the units of a layer inside a moved group, both transforms counted', () => {
		const { root, owner } = createDrawing();
		const group = svg(owner, 'g', { id: 'layer-2', transform: 'translate(10 0)' });
		const inner = svg(owner, 'g', { id: 'layer-3', transform: 'translate(0 20)' });
		group.appendChild(inner);
		root.appendChild(group);
		const info = layerInfo('layer-3', { depth: 1, parentId: 'layer-2' });
		const { context } = createFake(
			root,
			[layerInfo('layer-1'), layerInfo('layer-2'), info],
			info
		);
		stroke(tool('pencil'), context, [
			{ x: 20, y: 30 },
			{ x: 30, y: 30 },
		]);
		expect(inner.firstElementChild?.getAttribute('d')).toBe('M 10 10 L 20 10');
	});

	it('hits a loose element where it is drawn, and wraps it before moving it', () => {
		const { root, owner } = createDrawing();
		const loose = svg(owner, 'rect', {
			id: 'r1',
			x: '0',
			y: '0',
			width: '10',
			height: '10',
			transform: 'translate(100 100)',
		});
		root.appendChild(loose);
		const info = layerInfo('r1', { loose: true });
		const { context, labels } = createFake(root, [layerInfo('layer-1'), info], info);
		const select = tool('select');
		select.begin(context, at(105, 105));
		expect(context.selection.elements).toEqual([loose]);
		select.move(context, at(110, 105));
		expect(loose.getAttribute('transform')).toBe('matrix(1 0 0 1 105 100)');
		select.end(context, at(115, 105));
		expect(labels).toEqual(['layers.wrap', 'tools.select']);
		expect(loose.parentElement?.id).toBe('layer-9');
		expect(loose.getAttribute('transform')).toBe('matrix(1 0 0 1 110 100)');
		expect(context.selection.elements).toEqual([loose]);
	});

	it('erases a loose element where it is drawn, wrapping it first', () => {
		const { root, owner } = createDrawing();
		const loose = svg(owner, 'circle', { id: 'c1', cx: '0', cy: '0', r: '5' });
		loose.setAttribute('transform', 'translate(200 200)');
		root.appendChild(loose);
		const info = layerInfo('c1', { loose: true });
		const { context, labels } = createFake(root, [layerInfo('layer-1'), info], info);
		stroke(tool('eraser'), context, [
			{ x: 0, y: 0 },
			{ x: 2, y: 2 },
		]);
		expect(labels).toEqual([]);
		stroke(tool('eraser'), context, [{ x: 200, y: 200 }]);
		expect(labels).toEqual(['layers.wrap', 'tools.eraser']);
		expect(owner.getElementById('layer-9')?.children.length).toBe(0);
	});
});

describe('the pencil', () => {
	it('adds one smoothed path, stroked in the fill colour where there is no stroke colour', () => {
		const { root, layer } = createDrawing();
		const info = layerInfo('layer-1');
		const { context, labels } = createFake(root, [info], info, {
			stroke: 'none',
			fill: '#ff0000',
			size: 6,
			opacity: 0.5,
		});
		stroke(tool('pencil'), context, WAVE);
		expect(labels).toEqual(['tools.pencil']);
		expect(layer.children.length).toBe(1);
		const path = layer.firstElementChild;
		expect(path?.localName).toBe('path');
		expect(path?.getAttribute('d')).toMatch(/^M 10 10 C /);
		expect(path?.getAttribute('stroke')).toBe('#ff0000');
		expect(path?.getAttribute('stroke-width')).toBe('6');
		expect(path?.getAttribute('fill')).toBe('none');
		expect(path?.getAttribute('stroke-linecap')).toBe('round');
		expect(path?.getAttribute('opacity')).toBe('0.5');
		expect(context.overlay.children.length).toBe(0);
	});

	it('prefers the stroke colour, previews on the overlay, and makes a dot of a stroke that did not move', () => {
		const { root, layer } = createDrawing();
		const info = layerInfo('layer-1');
		const { context } = createFake(root, [info], info, { stroke: '#00ff00', opacity: 1 });
		const pencil = tool('pencil');
		pencil.begin(context, at(5, 5));
		expect(context.overlay.children.length).toBe(1);
		expect(context.overlay.firstElementChild?.getAttribute('stroke')).toBe('#00ff00');
		expect(layer.children.length).toBe(0);
		pencil.end(context, at(5, 5));
		expect(context.overlay.children.length).toBe(0);
		const path = layer.firstElementChild;
		expect(path?.getAttribute('d')).toBe('M 5 5 L 5 5');
		expect(path?.getAttribute('stroke')).toBe('#00ff00');
		expect(path?.hasAttribute('opacity')).toBe(false);
	});

	it('draws in the layer’s own units on a moved layer', () => {
		const { root, layer } = createDrawing();
		layer.setAttribute('transform', 'translate(100, 50)');
		const info = layerInfo('layer-1');
		const { context } = createFake(root, [info], info);
		stroke(tool('pencil'), context, [
			{ x: 110, y: 60 },
			{ x: 120, y: 60 },
		]);
		expect(layer.firstElementChild?.getAttribute('d')).toBe('M 10 10 L 20 10');
	});

	it('leaves the layer and the overlay untouched when cancelled mid-stroke', () => {
		const { root, layer } = createDrawing();
		const info = layerInfo('layer-1');
		const { context, labels } = createFake(root, [info], info);
		const pencil = tool('pencil');
		pencil.begin(context, at(1, 1));
		pencil.move(context, at(5, 5));
		pencil.cancel(context);
		pencil.end(context, at(9, 9));
		expect(layer.children.length).toBe(0);
		expect(context.overlay.children.length).toBe(0);
		expect(labels).toEqual([]);
	});
});

describe('the brush', () => {
	it('adds one filled outline whose width follows pressure', () => {
		const { root, layer } = createDrawing();
		const info = layerInfo('layer-1');
		const { context, labels } = createFake(root, [info], info, {
			fill: '#123456',
			size: 10,
			pressure: true,
		});
		stroke(tool('brush'), context, WAVE, { pressure: 1 });
		expect(labels).toEqual(['tools.brush']);
		const path = layer.firstElementChild;
		expect(path?.localName).toBe('path');
		expect(path?.getAttribute('fill')).toBe('#123456');
		expect(path?.getAttribute('fill-rule')).toBe('nonzero');
		expect(path?.hasAttribute('stroke')).toBe(false);
		expect(path?.getAttribute('d')).toMatch(/^M .* Z$/);
		expect(context.overlay.children.length).toBe(0);
	});

	it('paints in the stroke colour where there is no fill colour', () => {
		const { root, layer } = createDrawing();
		const info = layerInfo('layer-1');
		const { context } = createFake(root, [info], info, { fill: 'none', stroke: '#abcdef' });
		stroke(tool('brush'), context, WAVE);
		expect(layer.firstElementChild?.getAttribute('fill')).toBe('#abcdef');
	});
});

describe('the eraser', () => {
	it('removes what the pointer passed over and nothing else, in one command', () => {
		const { root, layer } = createDrawing([
			{ id: 'a', x: '0', y: '0', width: '20', height: '20' },
			{ id: 'b', x: '100', y: '100', width: '20', height: '20' },
			{ tag: 'circle', id: 'c', cx: '60', cy: '10', r: '5' },
		]);
		const info = layerInfo('layer-1');
		const { context, labels } = createFake(root, [info], info, { size: 8 });
		const eraser = tool('eraser');
		eraser.begin(context, at(10, 10));
		expect(context.overlay.firstElementChild?.localName).toBe('circle');
		expect(context.overlay.firstElementChild?.getAttribute('r')).toBe('4');
		eraser.move(context, at(40, 10));
		eraser.move(context, at(52, 10));
		eraser.end(context, at(52, 10));
		expect(labels).toEqual(['tools.eraser']);
		expect([...layer.children].map((child) => child.id)).toEqual(['b']);
		expect(context.overlay.children.length).toBe(0);
	});

	it('finds what it erased by its place, so a redo erases it from a layer an undo rebuilt', () => {
		const { root, layer } = createDrawing([
			{ id: 'a', x: '0', y: '0', width: '20', height: '20' },
			{ id: 'b', x: '100', y: '100', width: '20', height: '20' },
		]);
		const rebuilt = layer.cloneNode(true) as Element;
		const info = layerInfo('layer-1');
		const { context, commands } = createFake(root, [info], info);
		stroke(tool('eraser'), context, [{ x: 10, y: 10 }]);
		expect([...layer.children].map((child) => child.id)).toEqual(['b']);
		layer.replaceWith(rebuilt);
		commands[0]?.apply(root);
		expect([...rebuilt.children].map((child) => child.id)).toEqual(['b']);
	});

	it('does nothing when it touched nothing', () => {
		const { root, layer } = createDrawing([
			{ id: 'a', x: '0', y: '0', width: '20', height: '20' },
		]);
		const info = layerInfo('layer-1');
		const { context, labels } = createFake(root, [info], info);
		stroke(tool('eraser'), context, [
			{ x: 200, y: 200 },
			{ x: 220, y: 220 },
		]);
		expect(labels).toEqual([]);
		expect(layer.children.length).toBe(1);
	});
});

describe('the fill', () => {
	it('sets the fill of the topmost element under the pointer, clearing a fill in its style', () => {
		const { root, layer } = createDrawing([
			{ id: 'under', x: '0', y: '0', width: '50', height: '50', fill: '#000000' },
			{
				id: 'over',
				x: '10',
				y: '10',
				width: '50',
				height: '50',
				style: 'fill: red; stroke: blue',
			},
		]);
		const info = layerInfo('layer-1');
		const { context, labels } = createFake(root, [info], info, { fill: '#00ff00' });
		const fill = tool('fill');
		fill.begin(context, at(20, 20));
		fill.end(context, at(20, 20));
		expect(labels).toEqual(['tools.fill']);
		const over = layer.querySelector('#over');
		expect(over?.getAttribute('fill')).toBe('#00ff00');
		expect(over?.getAttribute('style')).toBe('stroke: blue');
		expect(layer.querySelector('#under')?.getAttribute('fill')).toBe('#000000');
	});

	it('does nothing where nothing is under the pointer', () => {
		const { root } = createDrawing([{ id: 'a', x: '0', y: '0', width: '20', height: '20' }]);
		const info = layerInfo('layer-1');
		const { context, labels } = createFake(root, [info], info);
		tool('fill').begin(context, at(200, 200));
		expect(labels).toEqual([]);
	});
});

describe('the eyedropper', () => {
	it('reads the fill under the pointer, the stroke with Alt, and black where nothing says', () => {
		const { root } = createDrawing([
			{
				id: 'a',
				x: '0',
				y: '0',
				width: '20',
				height: '20',
				fill: '#ff0000',
				stroke: '#00ff00',
			},
			{ id: 'b', x: '50', y: '0', width: '20', height: '20', style: 'fill:#0000ff' },
			{ id: 'c', x: '100', y: '0', width: '20', height: '20' },
		]);
		const info = layerInfo('layer-1', { locked: true });
		const { context, colours, labels } = createFake(root, [info], info);
		const eyedropper = tool('eyedropper');
		eyedropper.begin(context, at(10, 10));
		eyedropper.begin(context, at(10, 10, { altKey: true }));
		eyedropper.begin(context, at(60, 10));
		eyedropper.begin(context, at(110, 10));
		eyedropper.begin(context, at(110, 10, { altKey: true }));
		eyedropper.begin(context, at(500, 500));
		expect(colours).toEqual([
			['fill', '#ff0000'],
			['stroke', '#00ff00'],
			['fill', '#0000ff'],
			['fill', '#000000'],
			['stroke', 'none'],
		]);
		expect(labels).toEqual([]);
	});

	it('reads a colour the layer gives its children', () => {
		const { root, layer } = createDrawing([
			{ id: 'a', x: '0', y: '0', width: '20', height: '20' },
		]);
		layer.setAttribute('fill', '#333333');
		const info = layerInfo('layer-1');
		const { context, colours } = createFake(root, [info], info);
		tool('eyedropper').begin(context, at(10, 10));
		expect(colours).toEqual([['fill', '#333333']]);
	});

	it('reads a colour a group gives the layers in it', () => {
		const { root, owner } = createDrawing();
		const group = svg(owner, 'g', { id: 'layer-2', fill: '#444444' });
		const inner = svg(owner, 'g', { id: 'layer-3' });
		inner.appendChild(svg(owner, 'rect', { x: '0', y: '0', width: '20', height: '20' }));
		group.appendChild(inner);
		root.appendChild(group);
		const info = layerInfo('layer-3', { depth: 1, parentId: 'layer-2' });
		const { context, colours } = createFake(root, [layerInfo('layer-2'), info], info);
		tool('eyedropper').begin(context, at(10, 10));
		expect(colours).toEqual([['fill', '#444444']]);
	});
});

describe('the shapes', () => {
	it('makes a rectangle from a drag, square when constrained, rounded by the corner radius', () => {
		const { root, layer } = createDrawing();
		const info = layerInfo('layer-1');
		const { context, labels } = createFake(root, [info], info, {
			fill: 'none',
			stroke: '#111111',
			strokeWidth: 3,
			cornerRadius: 4,
			constrain: true,
		});
		stroke(tool('rectangle'), context, [
			{ x: 10, y: 10 },
			{ x: 50, y: 30 },
			{ x: 70, y: 30 },
		]);
		expect(labels).toEqual(['tools.rectangle']);
		const rect = layer.firstElementChild;
		expect(rect?.localName).toBe('rect');
		expect(rect?.getAttribute('x')).toBe('10');
		expect(rect?.getAttribute('y')).toBe('10');
		expect(rect?.getAttribute('width')).toBe('60');
		expect(rect?.getAttribute('height')).toBe('60');
		expect(rect?.getAttribute('rx')).toBe('4');
		expect(rect?.getAttribute('ry')).toBe('4');
		expect(rect?.getAttribute('fill')).toBe('none');
		expect(rect?.getAttribute('stroke')).toBe('#111111');
		expect(rect?.getAttribute('stroke-width')).toBe('3');
		expect(context.overlay.children.length).toBe(0);
	});

	it('writes a shape to two decimals, as a path is written, from a pointer between pixels', () => {
		const { root, layer } = createDrawing();
		const info = layerInfo('layer-1');
		const { context } = createFake(root, [info], info);
		stroke(tool('rectangle'), context, [
			{ x: 209.9547511312217, y: 401.3574660633484 },
			{ x: 571.9457013574661, y: 672.8506787330317 },
		]);
		const rect = layer.firstElementChild;
		expect(rect?.getAttribute('x')).toBe('209.95');
		expect(rect?.getAttribute('y')).toBe('401.36');
		expect(rect?.getAttribute('width')).toBe('361.99');
		expect(rect?.getAttribute('height')).toBe('271.49');
	});

	it('leaves the stroke off a filled shape with no stroke colour, and previews while dragging', () => {
		const { root, layer } = createDrawing();
		const info = layerInfo('layer-1');
		const { context } = createFake(root, [info], info, { fill: '#222222', stroke: 'none' });
		const ellipse = tool('ellipse');
		ellipse.begin(context, at(0, 0));
		ellipse.move(context, at(40, 20));
		expect(context.overlay.firstElementChild?.localName).toBe('ellipse');
		expect(context.overlay.firstElementChild?.getAttribute('rx')).toBe('20');
		expect(layer.children.length).toBe(0);
		ellipse.end(context, at(40, 20));
		const made = layer.firstElementChild;
		expect(made?.localName).toBe('ellipse');
		expect(made?.getAttribute('cx')).toBe('20');
		expect(made?.getAttribute('cy')).toBe('10');
		expect(made?.getAttribute('rx')).toBe('20');
		expect(made?.getAttribute('ry')).toBe('10');
		expect(made?.getAttribute('fill')).toBe('#222222');
		expect(made?.hasAttribute('stroke')).toBe(false);
		expect(made?.hasAttribute('rx')).toBe(true);
	});

	it('snaps a line to 45° with Shift and strokes it in the fill colour where there is no stroke', () => {
		const { root, layer } = createDrawing();
		const info = layerInfo('layer-1');
		const { context } = createFake(root, [info], info, {
			fill: '#ff00ff',
			stroke: 'none',
			strokeWidth: 2,
		});
		stroke(
			tool('line'),
			context,
			[
				{ x: 0, y: 0 },
				{ x: 100, y: 80 },
			],
			{ shiftKey: true }
		);
		const line = layer.firstElementChild;
		expect(line?.localName).toBe('line');
		const x2 = Number(line?.getAttribute('x2'));
		const y2 = Number(line?.getAttribute('y2'));
		expect(x2).toBeCloseTo(y2, 5);
		expect(Math.hypot(x2, y2)).toBeCloseTo(Math.hypot(100, 80), 1);
		expect(line?.getAttribute('stroke')).toBe('#ff00ff');
		expect(line?.getAttribute('stroke-width')).toBe('2');
	});

	it('makes nothing of a click', () => {
		const { root, layer } = createDrawing();
		const info = layerInfo('layer-1');
		const { context, labels } = createFake(root, [info], info);
		stroke(tool('rectangle'), context, [
			{ x: 10, y: 10 },
			{ x: 10.5, y: 10.2 },
		]);
		expect(labels).toEqual([]);
		expect(layer.children.length).toBe(0);
	});
});

const THREE = [
	{ id: 'a', x: '0', y: '0', width: '40', height: '40' },
	{ id: 'b', x: '20', y: '20', width: '40', height: '40' },
	{ id: 'c', x: '200', y: '200', width: '10', height: '10' },
];

describe('the select tool', () => {
	it('selects the topmost element under a click, adds with Shift, and draws the box', () => {
		const { root, layer } = createDrawing(THREE);
		const info = layerInfo('layer-1');
		const { context } = createFake(root, [info], info);
		const select = tool('select');
		select.begin(context, at(30, 30));
		select.end(context, at(30, 30));
		expect(context.selection.elements.map((e) => e.id)).toEqual(['b']);
		expect(context.overlay.querySelector('[data-draw-selection]')).not.toBeNull();
		expect(context.overlay.querySelectorAll('[data-handle]').length).toBe(9);
		select.begin(context, at(5, 5, { shiftKey: true }));
		select.end(context, at(5, 5, { shiftKey: true }));
		expect(context.selection.elements.map((e) => e.id)).toEqual(['b', 'a']);
		select.begin(context, at(30, 30, { shiftKey: true }));
		select.end(context, at(30, 30, { shiftKey: true }));
		expect(context.selection.elements.map((e) => e.id)).toEqual(['a']);
		expect(layer.querySelector('#b')?.hasAttribute('transform')).toBe(false);
	});

	it('moves what it drags, live, restoring the layer before the command sets the result', () => {
		const { root, layer } = createDrawing(THREE);
		const info = layerInfo('layer-1');
		const { context, labels, onExecute } = createFake(root, [info], info);
		const b = layer.querySelector('#b');
		const seen: (string | null)[] = [];
		onExecute.current = () => seen.push(b?.getAttribute('transform') ?? null);
		const select = tool('select');
		select.begin(context, at(30, 30));
		select.move(context, at(40, 35));
		expect(b?.getAttribute('transform')).toBe('matrix(1 0 0 1 10 5)');
		select.move(context, at(60, 50));
		select.end(context, at(60, 50));
		expect(labels).toEqual(['tools.select']);
		expect(seen).toEqual([null]);
		expect(b?.getAttribute('transform')).toBe('matrix(1 0 0 1 30 20)');
		expect(layer.querySelector('#a')?.hasAttribute('transform')).toBe(false);
	});

	it('composes a move with the transform an element already has', () => {
		const { root, layer } = createDrawing([
			{ id: 'a', x: '0', y: '0', width: '10', height: '10', transform: 'translate(100 100)' },
		]);
		const info = layerInfo('layer-1');
		const { context } = createFake(root, [info], info);
		const select = tool('select');
		select.begin(context, at(105, 105));
		select.end(context, at(115, 105));
		expect(layer.querySelector('#a')?.getAttribute('transform')).toBe(
			'matrix(1 0 0 1 110 100)'
		);
	});

	it('makes no command of a click on an element that has a transform already', () => {
		const { root, layer } = createDrawing([
			{ id: 'a', x: '0', y: '0', width: '10', height: '10', transform: 'translate(100 100)' },
		]);
		const info = layerInfo('layer-1');
		const { context, labels } = createFake(root, [info], info);
		const select = tool('select');
		select.begin(context, at(105, 105));
		select.end(context, at(105, 105));
		expect(labels).toEqual([]);
		expect(layer.querySelector('#a')?.getAttribute('transform')).toBe('translate(100 100)');
	});

	it('moves on a moved layer by what the pointer moved, with the box where the element is drawn', () => {
		const { root, layer } = createDrawing([
			{ id: 'a', x: '0', y: '0', width: '10', height: '10' },
		]);
		layer.setAttribute('transform', 'translate(100 50)');
		const info = layerInfo('layer-1');
		const { context } = createFake(root, [info], info);
		const select = tool('select');
		select.begin(context, at(105, 55));
		select.end(context, at(115, 55));
		expect(layer.querySelector('#a')?.getAttribute('transform')).toBe('matrix(1 0 0 1 10 0)');
		const box = context.overlay.querySelector(
			'[data-draw-selection] > rect:not([data-handle])'
		);
		expect(box?.getAttribute('x')).toBe('110');
		expect(box?.getAttribute('y')).toBe('50');
	});

	it('leaves alone what is selected on another layer', () => {
		const { root, owner } = createDrawing(THREE);
		const other = svg(owner, 'g', { id: 'layer-2' });
		const elsewhere = svg(owner, 'rect', { x: '300', y: '300', width: '10', height: '10' });
		other.appendChild(elsewhere);
		root.appendChild(other);
		const info = layerInfo('layer-1');
		const { context, labels } = createFake(root, [info, layerInfo('layer-2')], info);
		context.selection.set([elsewhere]);
		const select = tool('select');
		// Where the other layer's south-east handle is: a marquee here, not a resize.
		select.begin(context, at(310, 310));
		select.move(context, at(400, 400));
		select.end(context, at(400, 400));
		expect(elsewhere.hasAttribute('transform')).toBe(false);
		context.selection.set([elsewhere]);
		deleteSelection(context);
		expect(labels).toEqual([]);
		expect(other.children.length).toBe(1);
	});

	it('makes no command of a click that did not move', () => {
		const { root } = createDrawing(THREE);
		const info = layerInfo('layer-1');
		const { context, labels } = createFake(root, [info], info);
		const select = tool('select');
		select.begin(context, at(30, 30));
		select.end(context, at(30, 30));
		select.begin(context, at(30, 30));
		select.end(context, at(30, 30));
		expect(labels).toEqual([]);
	});

	it('resizes about the opposite corner from a handle, and rotates from the handle above, snapping with Shift', () => {
		const { root, layer } = createDrawing([
			{ id: 'a', x: '10', y: '10', width: '100', height: '50' },
		]);
		const info = layerInfo('layer-1');
		const { context, labels } = createFake(root, [info], info);
		const a = layer.querySelector('#a');
		context.selection.set(a === null ? [] : [a]);
		const select = tool('select');
		// The south-east handle sits on the far corner; dragging it doubles both sides.
		select.begin(context, at(110, 60));
		select.move(context, at(160, 85));
		select.end(context, at(210, 110));
		expect(labels).toEqual(['tools.select']);
		expect(a?.getAttribute('transform')).toBe('matrix(2 0 0 2 -10 -10)');
		// The box is now 10,10 to 210,110; the rotate handle is 24 screen px above its top middle.
		const centre = { x: 110, y: 60 };
		const handle = { x: 110, y: 10 - 24 };
		const radius = centre.y - handle.y;
		const angle = (-90 + 20) * (Math.PI / 180);
		const to = {
			x: centre.x + radius * Math.cos(angle),
			y: centre.y + radius * Math.sin(angle),
		};
		select.begin(context, at(handle.x, handle.y));
		select.end(context, at(to.x, to.y, { shiftKey: true }));
		const expected = rotate(15, centre);
		const resized = parseTransform('matrix(2 0 0 2 -10 -10)');
		const corner = apply(parseTransform(a?.getAttribute('transform') ?? null), {
			x: 10,
			y: 10,
		});
		const turned = apply(expected, apply(resized, { x: 10, y: 10 }));
		expect(corner.x).toBeCloseTo(turned.x, 2);
		expect(corner.y).toBeCloseTo(turned.y, 2);
	});

	it('selects what a marquee crosses, clearing what was selected unless Shift is held', () => {
		const { root, layer } = createDrawing(THREE);
		const info = layerInfo('layer-1');
		const { context, labels } = createFake(root, [info], info);
		const c = layer.querySelector('#c');
		context.selection.set(c === null ? [] : [c]);
		const select = tool('select');
		select.begin(context, at(100, 100));
		select.move(context, at(50, 50));
		expect(
			context.overlay.querySelector('rect:not([data-handle])')?.getAttribute('width')
		).toBe('50');
		select.end(context, at(50, 50));
		expect(context.selection.elements.map((e) => e.id)).toEqual(['b']);
		select.begin(context, at(300, 300, { shiftKey: true }));
		select.end(context, at(205, 205, { shiftKey: true }));
		expect(context.selection.elements.map((e) => e.id)).toEqual(['b', 'c']);
		expect(labels).toEqual([]);
		expect(context.overlay.querySelectorAll('[data-draw-selection]').length).toBe(1);
	});

	it('puts things back when cancelled mid-drag, and leaves the overlay empty after a cancelled marquee', () => {
		const { root, layer } = createDrawing(THREE);
		const info = layerInfo('layer-1');
		const { context, labels } = createFake(root, [info], info);
		const select = tool('select');
		select.begin(context, at(30, 30));
		select.move(context, at(80, 80));
		select.cancel(context);
		expect(layer.querySelector('#b')?.hasAttribute('transform')).toBe(false);
		expect(labels).toEqual([]);
		context.selection.clear();
		select.begin(context, at(300, 300));
		select.move(context, at(350, 350));
		select.cancel(context);
		expect(context.overlay.children.length).toBe(0);
	});

	it('deletes the selection in one command and forgets it', () => {
		const { root, layer } = createDrawing(THREE);
		const info = layerInfo('layer-1');
		const { context, labels } = createFake(root, [info], info);
		const select = tool('select');
		select.begin(context, at(30, 30));
		select.end(context, at(30, 30));
		select.begin(context, at(205, 205, { shiftKey: true }));
		select.end(context, at(205, 205, { shiftKey: true }));
		deleteSelection(context);
		expect(labels).toEqual(['tools.select']);
		expect([...layer.children].map((child) => child.id)).toEqual(['a']);
		expect(context.selection.elements).toEqual([]);
		expect(context.overlay.children.length).toBe(0);
	});

	it('does nothing on a locked layer but say so', () => {
		const { root } = createDrawing(THREE);
		const info = layerInfo('layer-1', { locked: true });
		const { context, notices } = createFake(root, [info], info);
		const select = tool('select');
		select.begin(context, at(30, 30));
		select.end(context, at(60, 60));
		expect(notices).toEqual([t('layers.locked', { name: 'Layer 1' })]);
		expect(context.selection.elements).toEqual([]);
	});
});

describe('measureOf', () => {
	it('reads a box from the attributes where the browser cannot measure', () => {
		const { owner } = createDrawing();
		expect(measureOf(svg(owner, 'circle', { cx: '10', cy: '20', r: '5' }))).toEqual({
			x: 5,
			y: 15,
			width: 10,
			height: 10,
		});
		expect(measureOf(svg(owner, 'line', { x1: '10', y1: '0', x2: '0', y2: '10' }))).toEqual({
			x: 0,
			y: 0,
			width: 10,
			height: 10,
		});
		expect(measureOf(svg(owner, 'path', { d: 'M 1 2 L 11 2 L 11 22' }))).toEqual({
			x: 1,
			y: 2,
			width: 10,
			height: 20,
		});
		expect(measureOf(svg(owner, 'text', { x: '3', y: '4' }))).toEqual({
			x: 3,
			y: 4,
			width: 0,
			height: 0,
		});
	});
});
